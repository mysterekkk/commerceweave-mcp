# Changelog

## 0.3.0

- **Streamable HTTP transport** (`commerceweave-mcp serve-http`): mandatory bearer token (min 32 chars, constant-time check), loopback bind by default, Host/Origin validation against DNS rebinding, `/mcp` only, throttling of wrong credentials (never locks out the valid token), refuses non-loopback binds without an explicit opt-in and allowed hosts. Approvals stay a terminal-only human action, so HTTP clients cannot approve writes.
- **Base.com product creation** through the same approved-proposal flow (`addInventoryProduct`; new products only, never updates, SKU must not exist, catalog/price group/warehouse must be explicit when ambiguous).

## 0.2.0

- New approved proposal types: Allegro offer publish/end (`commerce_prepare_offer_publication`, async publication command API) and WooCommerce DRAFT product creation (`commerce_prepare_product_draft`, SKU required, never overwrites, never published).
- Dependabot no longer proposes major-version bumps automatically.

## 0.1.2

- Approval screen escapes control, ANSI, bidi and zero-width characters in all untrusted values; notes may not contain line breaks or control characters.
- Base.com ids are validated as plain integers and the returned order id is checked against the requested one before any read-modify-write.

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

Not yet validated against live platform accounts.
