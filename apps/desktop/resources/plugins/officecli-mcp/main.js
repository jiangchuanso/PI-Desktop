// OfficeCli MCP plugin entry.
// The actual document tooling is provided by the declarative MCP server in
// manifest.json (officecli mcp over stdio); this process only needs to satisfy
// the plugin lifecycle contract.
async function onLoad() {}

async function onUnload() {}

module.exports = { onLoad, onUnload };
