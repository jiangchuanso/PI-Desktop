import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Bundled MCP plugins (ADR 0038, ADR 0104, ADR 0105).
 *
 * officecli and searxng ship as ordinary bundled plugins: Electron resolves
 * `resources/plugins` at runtime and electron-builder copies that directory
 * outside the asar, so a package dropped in it is loaded and packaged with no
 * further wiring. These assertions guard the two halves that make it true — the
 * packages sit in that directory, and each declares a stdio server the host
 * either finds on PATH or launches out of its own package.
 */

const PLUGIN_DIRS = ["officecli-mcp", "searxng"];

/** Mirror of `MCP_SERVER_ID` in the plugin SDK. */
const MCP_SERVER_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/** A command with no path separator must be a launchable executable name. */
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const read = (path) => readFileSync(resolve(path), "utf8");
const manifestOf = (dir) => JSON.parse(read(`${dir}/manifest.json`));

test("bundled MCP plugins live where the app loads and packages plugins", () => {
  for (const name of PLUGIN_DIRS) {
    const dir = `resources/plugins/${name}`;
    assert.ok(existsSync(resolve(`${dir}/manifest.json`)), `${dir} must ship`);
    assert.ok(existsSync(resolve(`${dir}/${manifestOf(dir).main}`)), `${dir} main entry`);
    // The repository root `plugins/` directory is on no load path and in no
    // packaging rule, so a package left there is invisible after install.
    assert.equal(
      existsSync(resolve(`../plugins/${name}`)),
      false,
      `${name} must not be staged under the repository root`,
    );
  }
});

test("each bundled MCP plugin declares one stdio server", () => {
  for (const name of PLUGIN_DIRS) {
    const dir = `resources/plugins/${name}`;
    const manifest = manifestOf(dir);
    const servers = manifest?.contributes?.mcpServers;
    assert.ok(Array.isArray(servers), `${name} declares contributes.mcpServers`);
    assert.equal(servers.length, 1, `${name} declares exactly one MCP server`);

    const server = servers[0];
    assert.match(server.id, MCP_SERVER_ID, `${name} MCP server id`);
    assert.equal(server.transport, "stdio");
    assert.equal(server.url, undefined);
    assert.equal(server.headers, undefined);
    // A stdio server is gated on this permission in both host-core and the
    // desktop runtime; a manifest that omits it loads with zero tools.
    assert.ok(
      manifest.permissions.includes("mcp.server.local"),
      `${name} must hold mcp.server.local`,
    );

    assert.equal(typeof server.command, "string");
    if (!/[\\/]/.test(server.command)) {
      assert.match(server.command, BARE_COMMAND, `${name} command must be a runnable name`);
    } else {
      // A plugin-relative command is resolved inside the package.
      assert.ok(existsSync(resolve(dir, server.command)), `${name} command must exist`);
    }
    for (const arg of server.args ?? []) {
      assert.equal(typeof arg, "string");
      assert.ok(!arg.split(/[\\/]/).includes(".."), `${name} args must not traverse upward`);
    }
  }
});

test("a declared env reference resolves against the plugin's own settings", () => {
  // `registerMcpServers` resolves `{ setting }` out of `plugin.getSettings()`;
  // a reference to a key the manifest never declares fails the server with
  // CONFIG_MISSING and it contributes no tools at all.
  for (const name of PLUGIN_DIRS) {
    const dir = `resources/plugins/${name}`;
    const manifest = manifestOf(dir);
    const declared = new Set((manifest?.contributes?.settings ?? []).map((entry) => entry.key));
    for (const server of manifest?.contributes?.mcpServers ?? []) {
      for (const [key, value] of Object.entries(server.env ?? {})) {
        if (typeof value === "string") continue;
        assert.ok(
          declared.has(value?.setting),
          `${name}: env ${key} references undeclared setting ${value?.setting}`,
        );
      }
    }
  }
});

test("searxng runs its own script, so the endpoint setting is the only input", () => {
  const dir = "resources/plugins/searxng";
  const manifest = manifestOf(dir);
  const server = manifest.contributes.mcpServers[0];
  assert.equal(server.command, "node");
  const script = server.args[0];
  assert.ok(script.endsWith(".js"), "searxng launches a JavaScript server");
  assert.ok(existsSync(resolve(dir, script)), `${script} must ship beside the manifest`);
  const setting = manifest.contributes.settings.find((entry) => entry.key === server.env.SEARXNG_API_URL.setting);
  assert.ok(setting, "SEARXNG_API_URL must be a declared setting");
  assert.equal(setting.type, "string");
  assert.match(setting.default, /^https?:\/\//, "the shipped default is an http endpoint");
});
