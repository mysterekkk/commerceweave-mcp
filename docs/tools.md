# Tool reference

Counts below are verified by a test that lists tools over real stdio.

## Unified tools (`commerce_*`)

Available whenever the server runs (with demo data or any connection).

| Tool | Mode | Purpose |
|---|---|---|
| `commerce_list_connections` | read | connection ids, platform, environment, write capability, active mode |
| `commerce_list_products` | read | normalized products/offers per connection (paged) |
| `commerce_find_product` | read | SKU / EAN / name lookup across connections (candidates, not proof) |
| `commerce_list_orders` | read | orders for a local day / last N days / range, de-duplicated, PII masked |
| `commerce_get_order` | read | one order |
| `commerce_low_stock` | read | items with stock ≤ threshold (variants individually) |
| `commerce_inventory_report` | read | per-connection item/unit/out-of-stock/low/unmanaged counts |
| `commerce_sales_summary` | read | gross revenue per currency and connection, duplicates handled, caveats listed |
| `commerce_find_stock_discrepancies` | read | same product, different stock across connections; optional suggested updates |
| `commerce_prepare_stock_update` | proposal+ | record a stock-change plan (no write) |
| `commerce_prepare_price_update` | proposal+ | record a price-change plan with exact decimal maths (no write) |
| `commerce_prepare_order_status_update` | proposal+ | record an order-status change plan (no write) |
| `commerce_prepare_order_note` | proposal+ | record a plan to add an internal order note (Woo private note, Base seller comment; no write) |
| `commerce_get_proposal` | proposal+ | show a proposal and its result |
| `commerce_execute_proposal` | approval_required | run a human-approved proposal once |

## Platform tools

Registered only for platforms you configured (and not in demo mode). All are read-only.

**Allegro (9):** `allegro_get_account_info`, `allegro_list_offers`, `allegro_search_offers`, `allegro_get_offer`, `allegro_get_offer_stock`, `allegro_get_offer_price`, `allegro_list_orders`, `allegro_get_order`, `allegro_get_order_events`.

**Base.com (8):** `base_list_inventories`, `base_get_inventory_products`, `base_get_product_stock`, `base_get_product_prices`, `base_list_orders`, `base_get_order`, `base_get_order_statuses`, `base_get_order_journal`.

**WooCommerce (9):** `woo_list_products`, `woo_search_products`, `woo_get_product`, `woo_get_product_variations`, `woo_get_stock`, `woo_get_categories`, `woo_list_orders`, `woo_get_order`, `woo_get_sales_report`.

## Writes are unified on purpose

The roadmap list contained platform-specific write tools (`allegro_update_offer_price`, `woo_update_stock`, …). Version 0.1.0 deliberately exposes **one** write path instead: `commerce_prepare_*` then human approval then `commerce_execute_proposal`. That keeps every write behind the same checks and avoids 14 near-duplicate tools.

| Write capability | Allegro | Base.com | WooCommerce |
|---|---|---|---|
| stock | offer quantity command (async, polled) | per catalog/warehouse/variant | product or variation |
| price | offer price command (async, polled) | per catalog/price group/variant | regular price of product or variation |
| order status | fulfillment status (revision-checked) | status id | core statuses |
| internal order note | not supported | appended to seller comment (200 char limit) | private staff note |
| product drafts, offer publish/end | not implemented | not implemented | not implemented |

## MCP extras

- Resource `commerceweave://connections` (ids, platforms, mode; no credentials).
- Prompts: `daily_orders`, `low_stock_check`, `weekly_sales`, `stock_sync_review`.
- Tool annotations: read tools `readOnlyHint`; prepare tools non-read-only, non-destructive; execute `destructiveHint`.
- Output is JSON text plus `structuredContent`. No `outputSchema` is declared in 0.1.0 (results are validated by tests, not advertised).

## Scenario → tool

| Ask | Tool |
|---|---|
| "Show today's orders across all stores." | `commerce_list_orders` |
| "What is running low?" | `commerce_low_stock` |
| "Raise these 10 prices by 5%." | `commerce_prepare_price_update` → `commerceweave-mcp approve` → `commerce_execute_proposal` |
| "Do Base and Woo have the same stock?" | `commerce_find_stock_discrepancies` |
| "How much did I sell in 7 days?" | `commerce_sales_summary` |
