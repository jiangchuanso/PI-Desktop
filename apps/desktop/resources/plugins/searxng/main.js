// SearXNG MCP plugin entry.
// The search tooling is provided by the declarative MCP server in
// manifest.json (node server.js over stdio). This process only satisfies the
// plugin lifecycle contract.
async function onLoad() {}

async function onUnload() {}

module.exports = { onLoad, onUnload };
