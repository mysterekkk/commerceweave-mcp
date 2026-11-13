# MCP Registry

`server.json` in the repository root follows the schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.

| Field | Value |
|---|---|
| name | `io.github.mysterekkk/commerceweave-mcp` (GitHub-namespace, verified by logging in as that GitHub account) |
| package | npm `commerceweave-mcp` 0.1.0, transport `stdio` |
| npm verification | `package.json` contains `"mcpName": "io.github.mysterekkk/commerceweave-mcp"` as the registry requires |

## Status

npm: **published** as `commerceweave-mcp@0.1.2`. Registry: **not published yet.** The registry validates that the npm package exists and carries the matching `mcpName`, so the order is:

1. `npm login` (needs your npm account and 2FA), then `npm publish` (version in `package.json` must match `server.json`).
2. Install the registry's `mcp-publisher` CLI (see https://github.com/modelcontextprotocol/registry), run `mcp-publisher login github`, then `mcp-publisher publish` from the repository root.
3. Verify at `https://registry.modelcontextprotocol.io/v0/servers?search=commerceweave`.

Other directories (community lists) generally ask for the GitHub URL and the npm package name; submit after step 1.
