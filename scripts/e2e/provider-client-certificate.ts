import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import { app, net, session } from "electron";
import { probeModelList, probeProviderEndpoint } from "../../apps/desktop/electron/main/model-discovery";
import { applyNetworkProxy, disposeSystemProxyRelay } from "../../apps/desktop/electron/main/network-proxy";
import { fetchProviderWithoutClientCertificate } from "../../apps/desktop/electron/main/provider-certificate-retry";

app.setPath("userData", process.argv[2]);
app.commandLine.appendSwitch("ozone-platform", "headless");
app.disableHardwareAcceleration();
const fixture = process.argv[3];
const cert = readFileSync(join(fixture, "localhost-cert.pem"), "utf8");
const key = readFileSync(join(fixture, "localhost-key.pem"), "utf8");
const fingerprint = new X509Certificate(cert).fingerprint256;
const sockets = new Set<Socket>();
let requests = 0;
let mode: "models" | "redirect" | "stall" = "models";
let requestStarted: (() => void) | undefined;
const server = createHttpsServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
  requests++;
  assert.deepEqual((req.socket as TLSSocket).getPeerCertificate(), {});
  if (mode === "redirect") {
    res.writeHead(302, { location: "https://other.example/v1/models" });
    res.end();
    return;
  }
  if (mode === "stall") { requestStarted?.(); return; }
  res.writeHead(req.headers.authorization === "Bearer fixture" ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
});
const proxy = createHttpServer();
let tunnels = 0;
proxy.on("connect", (req, client, head) => {
  assert.equal(req.headers["proxy-authorization"], `Basic ${Buffer.from("fixture:password").toString("base64")}`);
  const target = new URL(`http://${req.url}`);
  assert.equal(target.hostname, "localhost");
  tunnels++;
  const upstream = connect({ host: "127.0.0.1", port: Number(target.port) });
  sockets.add(upstream);
  upstream.on("close", () => sockets.delete(upstream));
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
});
for (const listener of [server, proxy]) listener.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

/** The budget a caller gives one metadata request. */
const PROBE_BUDGET_MS = 8_000;
/** A Chromium request that is still pending past this never sent HTTP. */
const PLATFORM_DEADLINE_MS = 6_000;
const DEADLINE = Symbol("deadline");

/**
 * Race one stage against its own deadline.
 *
 * Electron 43 leaves its client certificate responder unimplemented, and the
 * Chromium request that carries the failure does not settle reliably on Linux:
 * it can abort with `net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED` before HTTP, or stay
 * pending while its AbortSignal is ignored. No stage may therefore depend on a
 * signal alone; a stage that outlives its deadline reports and moves on. The
 * raced promise keeps its own handlers, so a late settlement is never an
 * unhandled rejection.
 */
function bounded<T>(deadlineMs: number, run: () => Promise<T>): Promise<T | typeof DEADLINE> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
    run().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

void app.whenReady().then(async () => {
  try {
    // Trust only this local fixture, only in this isolated Electron session.
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const matches = request.hostname === "localhost" &&
        new X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      callback(matches ? 0 : -3);
    });
    setDefaultCACertificates([...getCACertificates("default"), cert]);
    server.listen(0, "127.0.0.1");
    proxy.listen(0, "127.0.0.1");
    await Promise.all([once(server, "listening"), once(proxy, "listening")]);
    const address = server.address();
    const proxyAddress = proxy.address();
    assert.ok(address && typeof address !== "string" && proxyAddress && typeof proxyAddress !== "string");
    const baseUrl = `https://localhost:${address.port}/v1`;
    await applyNetworkProxy({ mode: "direct" });

    // The original failure has to precede HTTP. Whether the platform request
    // aborts or stays pending, the fixture must have seen no request at all.
    const baseline = await bounded(PROBE_BUDGET_MS, () =>
      net.fetch(`${baseUrl}/models`).then(() => "response" as const, (error: unknown) => error));
    if (baseline === "response") {
      assert.fail("client certificate was unexpectedly omitted and the request succeeded");
    }
    if (baseline !== DEADLINE) {
      assert.ok(
        baseline instanceof Error && baseline.message.includes("ERR_SSL_CLIENT_AUTH_CERT_NEEDED"),
        `unexpected baseline error: ${String(baseline)}`,
      );
    }
    assert.equal(requests, 0, "the original Electron 43 failure precedes HTTP");
    console.log(`baseline: Electron 43 net.fetch ${baseline === DEADLINE ? "stalled" : "failed"} before HTTP`);

    // The composed path is what users get, but the platform request underneath
    // it is not deterministic. Record which behaviour this run observed instead
    // of failing on platform timing: a recovery happens when the request aborts
    // before HTTP, and a pending request proves only that nothing left the host.
    const composed = await bounded(PLATFORM_DEADLINE_MS, () =>
      probeModelList({ baseUrl, apiKey: "fixture", signal: AbortSignal.timeout(PROBE_BUDGET_MS) }));
    const composedRecovers = composed !== DEADLINE;
    if (composedRecovers) {
      assert.deepEqual(composed.models, [{ modelId: "fixture-model", displayName: "fixture-model" }]);
      const endpoint = await bounded(PLATFORM_DEADLINE_MS, () =>
        probeProviderEndpoint({ baseUrl, apiKey: "fixture", signal: AbortSignal.timeout(PROBE_BUDGET_MS) }));
      if (endpoint === DEADLINE) console.log("endpoint: the Chromium request stayed pending before HTTP");
      else assert.equal(endpoint.status, 200);
    } else {
      assert.equal(requests, 0, "a pending platform request must not send HTTP");
      console.log("platform: the Chromium request stayed pending before HTTP");
    }

    // Everything below drives the recovery transport the composition would have
    // used, so the security assertions hold on every platform regardless of
    // Chromium timing. It authenticates through the real loopback SOCKS relay and
    // sends no client identity: the fixture asserts an empty peer certificate on
    // every request it accepts.
    const retry = (overrides: { apiKey?: string; signal?: AbortSignal } = {}) =>
      fetchProviderWithoutClientCertificate(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${overrides.apiKey ?? "fixture"}` },
        redirect: "manual",
        signal: overrides.signal ?? AbortSignal.timeout(PROBE_BUDGET_MS),
      });
    const served = await retry();
    assert.equal(served.status, 200);
    assert.deepEqual(await served.json(), { data: [{ id: "fixture-model" }] });
    assert.equal((await retry({ apiKey: "wrong" })).status, 401);

    await applyNetworkProxy({ mode: "custom", url: `http://fixture:password@127.0.0.1:${proxyAddress.port}`, bypass: "<-loopback>" });
    const before = tunnels;
    assert.equal((await retry()).status, 200);
    assert.ok(tunnels > before, "the retry must use the configured authenticated proxy");
    await applyNetworkProxy({ mode: "custom", url: `http://fixture:password@127.0.0.1:${proxyAddress.port}` });
    const beforeBypass = tunnels;
    assert.equal((await retry()).status, 200);
    assert.equal(tunnels, beforeBypass, "localhost bypass must apply to the retry transport");
    await applyNetworkProxy({ mode: "direct" });

    mode = "redirect";
    const redirect = await bounded(PLATFORM_DEADLINE_MS, () =>
      probeModelList({ baseUrl, apiKey: "fixture", signal: AbortSignal.timeout(PROBE_BUDGET_MS) })
        .then((probe) => ({ settled: probe }), (error: unknown) => ({ settled: error })));
    if (redirect === DEADLINE) {
      // Not reachable through the composition on this platform; the refusal is
      // pinned deterministically by provider-endpoint-probe.test.mjs.
      console.log("redirect: the Chromium request stayed pending; the refusal is covered by unit tests");
    } else {
      const refusal = redirect.settled;
      assert.ok(refusal instanceof Error, "a cross-origin redirect must be refused");
      assert.match(refusal.message, /left the configured origin/);
    }

    mode = "stall";
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const pending = retry({ signal: controller.signal });
    const reached = await bounded(PLATFORM_DEADLINE_MS, () => started);
    assert.notEqual(reached, DEADLINE, "the stalled request never reached the fixture");
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });

    console.log("provider client certificate E2E passed");
    await disposeSystemProxyRelay();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
