# Short community posts (do not post automatically)

## Allegro API community

CommerceWeave MCP is an open-source (MIT) local MCP server that includes an Allegro connector: OAuth2 device flow with refresh-token rotation, offer/order reads, and stock/price changes via the async command API (registered, polled, per-offer result checked). Writes are proposals approved by a human in a terminal. It is not yet validated on a live sandbox; I would appreciate sandbox testers. https://github.com/mysterekkk/commerceweave-mcp

## WooCommerce community

CommerceWeave MCP talks to the classic WooCommerce REST API v3 (consumer key/secret over HTTPS) and exposes products, variations, orders and a sales report to AI clients through MCP, read-only by default. It is not the first WooCommerce MCP, and WooCommerce has its own official integration in developer preview. The difference is one interface across WooCommerce, Base.com and Allegro, plus human-approved writes. https://github.com/mysterekkk/commerceweave-mcp

## TypeScript community

A TypeScript (strict, ESM, Node 22) MCP server built on `@modelcontextprotocol/server` v2 with Zod 4 schemas. Of possible interest: tests spawn the compiled server and drive it with the official MCP client over stdio; connectors are tested over real HTTP against local servers; money uses bigint decimals instead of floats. https://github.com/mysterekkk/commerceweave-mcp
