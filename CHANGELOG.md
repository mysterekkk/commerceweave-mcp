# Changelog

## 0.1.1

- WooCommerce connections are now DNS-pinned (undici agent): the validated address is the connected address, closing the DNS-rebinding window.
- New proposal type `commerce_prepare_order_note` (Woo private note, Base seller comment append with 200-char check, read-back verified).
- Tag-triggered npm publish workflow (needs the `NPM_TOKEN` repository secret).

## 0.1.0

First public version.

- MCP server (SDK v2, stdio) with 9 unified tools, 26 platform read tools, and proposal/approval tools by mode.
- Connectors: Allegro (OAuth2 device flow, refresh, async quantity/price commands, revision-checked order status), Base.com (X-BLToken, error-in-200 handling, 90/min limiter), WooCommerce REST v3 (variations, HTTPS-only, SSRF guard).
- Modes: `read_only` (default), `proposal`, `approval_required` with human terminal approval, single-use, plan-bound, expiring approvals, drift detection, read-back verification, audit log.
- De-duplication of imported orders, stock discrepancy detection, low stock, sales summary, time-zone aware ranges, exact decimal prices.
- Demo mode with synthetic data, CLI (`check`, `doctor`, `setup allegro`, `approve`, ...), English and Polish docs.

Not yet validated against live platform accounts. Not implemented: order notes, product drafts, offer publish/end, HTTP transport.
