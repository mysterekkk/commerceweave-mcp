# Setup per platform

Check anything at any time with `npx commerceweave-mcp check` (no network) or `doctor` (read-only call per connection). Neither prints secrets.

## Allegro

1. Register an application at https://apps.developer.allegro.pl/ (production) and/or the sandbox apps page. Allow the **device flow**. Sandbox may need account activation by Allegro; this project does not work around that.
2. Environment (set in your shell or client config, not in a committed file):
   ```
   ALLEGRO_ENABLED=true
   ALLEGRO_ENVIRONMENT=sandbox        # start here
   ALLEGRO_CLIENT_ID=...
   ALLEGRO_CLIENT_SECRET=...
   ```
3. Authorize: `npx commerceweave-mcp setup allegro`. Open the printed URL, approve, done. Tokens are stored in `~/.commerceweave/tokens/allegro.json` (set `COMMERCEWEAVE_TOKEN_KEY` to encrypt).
4. Verify: `npx commerceweave-mcp test-connection allegro`.
5. Several accounts: use a config file (`examples/config.example.json`), one entry per account with a unique `id`; run `setup allegro <id>` for each.

Needed API permissions depend on what you use: offers read, orders read; writes additionally need offer and order write permissions in your Allegro app.

## Base.com

1. In Base: *Account & other → My account → API*, generate a token.
2. `BASE_ENABLED=true` and `BASE_API_TOKEN=...`.
3. `npx commerceweave-mcp test-connection base`.
4. Order states: Base statuses are custom, so sales summaries cannot know which ones mean "paid" or "cancelled". Map them in the config file with `statusMap` (`{"1051":"open","1054":"cancelled"}`); unmapped orders are counted but flagged `ordersWithUnclassifiedStatus`.
5. If you have several catalogs/warehouses, write proposals must name them; reads work without.

Base's documented limit is 100 requests/minute; large catalogs make several calls, so some tools are slow by design.

## WooCommerce

1. WooCommerce → Settings → Advanced → REST API → Add key. Permission **Read** to start (use **Read/Write** only if you will use proposals).
2. `WOO_ENABLED=true`, `WOO_STORE_URL=https://your-shop.example`, `WOO_CONSUMER_KEY=ck_...`, `WOO_CONSUMER_SECRET=cs_...`.
3. `npx commerceweave-mcp test-connection woo`.
4. These are REST API keys, not WordPress Application Passwords.
5. Local development store over http: `WOO_ALLOW_INSECURE=true` (never for a real store).

## Connecting a client

- Claude Code: see `examples/claude-code/README.md`.
- Claude Desktop: `examples/claude-desktop/claude_desktop_config.json`.
- Cursor: `examples/cursor/mcp.json`.
- Any stdio MCP client: command `npx -y commerceweave-mcp`, env as above.

## Approving a write

```
commerceweave-mcp proposals          # list
commerceweave-mcp approve cw_abc123  # review, type the code
```
Requires `COMMERCEWEAVE_MODE=approval_required` on the server. See [safety.md](safety.md).
