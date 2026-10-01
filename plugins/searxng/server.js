#!/usr/bin/env node
// Zero-dependency MCP stdio server for the local E:\search service
// (a SearXNG-compatible file/document search backend built on Tantivy).
//
// E:\search exposes a SearXNG-compatible JSON API:
//   GET /search?q=<query>&format=json   -> { query, results:[{title,url,content,...}] }
//   GET /api/file-text/<path>            -> { file_id, filename, paragraphs:[...] }
// It listens on port 4607 by default.
//
// Configure the base URL with the SEARXNG_API_URL setting (Plugins UI) or by
// editing config.json after install. Precedence: setting(env) > config.json > default.
//
// Tools:
//   searxng_search    -> returns, per hit, the file title, its URL, and the
//                        MATCHED PARAGRAPHS (content) so they can be used as context.
//   searxng_read_file -> returns the FULL document text (all paragraphs) for a
//                        rel_path / filename / file_id, for deeper context.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

function resolveBase() {
  if (process.env.SEARXNG_API_URL) return process.env.SEARXNG_API_URL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    if (cfg && typeof cfg.SEARXNG_API_URL === "string" && cfg.SEARXNG_API_URL) {
      return cfg.SEARXNG_API_URL;
    }
  } catch {
    // no config.json or unreadable -> fall through to default
  }
  return "http://localhost:4607";
}

const BASE = resolveBase().replace(/\/+$/, "");

const TOOLS = [
  {
    name: "searxng_search",
    description:
      "Search the local E:\\search index (SearXNG-compatible). For each hit it returns the file title, its URL, and the MATCHED PARAGRAPHS (content) so the agent can use them directly as context. Chinese-aware: 'segmentation' (default) requires all jieba tokens to co-occur in a paragraph; 'synonym' also matches synonyms; 'none' is an exact substring match.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        mode: {
          type: "string",
          enum: ["segmentation", "synonym", "none"],
          description: "Search mode. Default 'segmentation'.",
        },
        limit: {
          type: "number",
          description: "Max number of file hits to return (default 10).",
        },
        paragraphs: {
          type: "number",
          description: "Max matched paragraphs per file to include in content (0 = all, default all).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "searxng_read_file",
    description:
      "Read the full text of an indexed document (all paragraphs) to use as context. Pass a rel_path, filename, or file_id obtained from a searxng_search result.",
    inputSchema: {
      type: "object",
      properties: {
        file_ref: {
          type: "string",
          description: "rel_path, filename, or file_id of an indexed document.",
        },
      },
      required: ["file_ref"],
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  // Notifications have a null id and need no response.
  if (msg.id === null || msg.id === undefined) return;

  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "searxng", version: "0.1.0" },
        },
      });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      break;
    case "tools/call":
      handleCall(msg);
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "method not found: " + msg.method },
      });
  }
});

async function handleCall(msg) {
  const { name, arguments: args } = msg.params || {};
  if (name === "searxng_search") return searchTool(msg, args || {});
  if (name === "searxng_read_file") return readFileTool(msg, args || {});
  send({
    jsonrpc: "2.0",
    id: msg.id,
    result: { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true },
  });
}

async function searchTool(msg, args) {
  const q = String(args.query ?? "").trim();
  if (!q) {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "query is required" }], isError: true },
    });
  }
  const url = new URL(BASE + "/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  if (args.mode) url.searchParams.set("mode", String(args.mode));
  if (args.paragraphs) url.searchParams.set("paragraphs", String(args.paragraphs));

  try {
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    const data = await res.json();
    const items = data.results || [];
    const limit = Number(args.limit || 10);
    if (items.length === 0) {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "No results from E:\\search." }] },
      });
    }
    const text = items
      .slice(0, limit)
      .map((r, i) => {
        const head =
          `### [${i + 1}] ${r.title || r.url}\n` +
          `URL: ${r.url}\n` +
          `Type: ${r.file_type || ""}  file_id: ${r.file_id || ""}  ` +
          `matched_paragraphs: ${r.snippet_count || 0}`;
        const body = (r.content || "").trim();
        return body ? `${head}\n\n${body}` : head;
      })
      .join("\n\n---\n\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  } catch (e) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "E:\\search request failed: " + e.message }],
        isError: true,
      },
    });
  }
}

async function readFileTool(msg, args) {
  const ref = String(args.file_ref ?? "").trim();
  if (!ref) {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "file_ref is required" }], isError: true },
    });
  }
  // Keep slashes literal, encode each path segment (handles spaces / CJK).
  const segs = ref.split("/").map((s) => encodeURIComponent(s));
  const url = BASE + "/api/file-text/" + segs.join("/");
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok || data.error) {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: "Read failed: " + (data.error || res.status) }],
          isError: true,
        },
      });
    }
    const paras = (data.paragraphs || []).join("\n\n");
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: `# ${data.filename || ref}\n\n${paras}` }] },
    });
  } catch (e) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "E:\\search request failed: " + e.message }],
        isError: true,
      },
    });
  }
}
