# CommerceWeave MCP v0.1.0

**One MCP server. Three commerce platforms.** First public release.

Connect AI agents (Claude Code, Claude Desktop, Cursor, any stdio MCP client) to Allegro, Base.com and WooCommerce through one local server. No VPS, no database, no SaaS account.

## Highlights

- 9 unified tools (`commerce_*`): orders across stores, low stock, inventory report, sales summary, stock discrepancies, product lookup.
- 26 read tools for Allegro, Base.com and WooCommerce (registered per configured platform).
- **Read-only by default.** Writes (stock, price, order status) are proposals with before/after and need a human approval in a terminal; approvals are single-use, expiring and bound to the exact plan.
- Imported orders are de-duplicated (confirmed vs potential), currencies never mixed, revenue never called profit.
- Demo mode with synthetic data: `COMMERCEWEAVE_DEMO=true`.
- English and Polish README.

## Honest status

- Tested against local servers implementing each platform's documented protocol plus real stdio MCP sessions. **Not yet validated against live Allegro / Base.com / WooCommerce accounts.**
- Not implemented: order notes, product drafts, offer publish/end, HTTP transport.
- Not affiliated with Allegro, Base.com/BaseLinker or WooCommerce. Does not replace their official integrations.

Docs: README, `docs/safety.md`, `docs/api-compatibility.md`.
