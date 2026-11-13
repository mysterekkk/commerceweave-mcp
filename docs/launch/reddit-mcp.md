# r/mcp draft (do not post automatically)

**Title:** CommerceWeave: a local MCP server for Allegro + Base.com + WooCommerce, read-only by default with human-approved writes

I wrote an MCP server (TypeScript, official SDK v2, stdio) that exposes three commerce platforms through one tool set.

- `commerce_*` tools: orders across stores, low stock, sales summary, stock discrepancies, product lookup
- platform read tools for each (9 Allegro / 8 Base.com / 9 WooCommerce)
- writes only as proposals; a human approves in a terminal (single-use, expiring, plan-bound). No approve tool exists, so a prompt-injected model cannot grant itself permission
- demo mode with synthetic data: `claude mcp add commerceweave-demo -e COMMERCEWEAVE_DEMO=true -- npx -y commerceweave-mcp`

Caveats: not yet tested on live accounts; narrower than single-platform servers; the approval needs the agent to not have shell access to your account. Details in `docs/safety.md`.

https://github.com/mysterekkk/commerceweave-mcp
