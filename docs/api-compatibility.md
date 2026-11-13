# API compatibility

**Verified on 2026-11-13.** Everything below was read from the vendors' own documentation on that day.
Nothing here was exercised against live accounts (see [Live testing status](#live-testing-status)).

## Model Context Protocol

| Item | Value | Source |
|---|---|---|
| SDK | `@modelcontextprotocol/server` **2.4.0** (v2 line, `latest` on npm) | https://github.com/modelcontextprotocol/typescript-sdk |
| Spec revision implemented by the SDK | 2026-07-28 (older clients served through the SDK's legacy path) | SDK README |
| Imports used | `McpServer` from `@modelcontextprotocol/server`, `serveStdio` from `@modelcontextprotocol/server/stdio`, schemas via `zod/v4` | https://ts.sdk.modelcontextprotocol.io/v2/ |
| Tests use | `Client` / `StdioClientTransport` from `@modelcontextprotocol/client` 2.4.0 | same |
| Registry manifest | `server.json`, schema `2025-12-11` | https://github.com/modelcontextprotocol/registry (docs/reference/server-json) |

v1 (`@modelcontextprotocol/sdk`) examples were **not** used.

## Allegro REST API

Source of truth: the official OpenAPI file https://developer.allegro.pl/swagger.yaml (OpenAPI 3.0, fetched 2026-11-13) plus https://developer.allegro.pl/documentation.

| Topic | What the implementation does |
|---|---|
| Hosts | API `https://api.allegro.pl` / sandbox `https://api.allegro.pl.allegrosandbox.pl`; OAuth `https://allegro.pl` / `https://allegro.pl.allegrosandbox.pl` |
| Media type | `application/vnd.allegro.public.v1+json` on every call |
| OAuth2 | Device flow (`POST /auth/oauth/device`, then poll `POST /auth/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, handling `authorization_pending` / `slow_down`). Refresh via `grant_type=refresh_token`; the **rotated** refresh token is persisted every time. Basic auth with client id/secret. The spec lists authorization-code, device and client-credentials; the CLI uses the device flow because it needs no redirect URI. |
| Reads | `GET /me`, `GET /sale/offers` (`limit`, `offset`, `name`, `publication.status`, `sellingMode.price.amount.gte/lte`, `offer.id`, `external.id`), `GET /sale/product-offers/{offerId}`, `GET /order/checkout-forms` (`lineItems.boughtAt.gte/lte`, `limit`, `offset`, `totalCount`), `GET /order/checkout-forms/{id}`, `GET /order/events` |
| Stock write | `PUT /sale/offer-quantity-change-commands/{commandId}` body `{modification:{changeType:"FIXED",value}, offerCriteria:[{offers:[{id}],type:"CONTAINS_OFFERS"}]}` (client-generated UUID) |
| Price write | `PUT /sale/offer-price-change-commands/{commandId}` body `{modification:{type:"FIXED_PRICE",price:{amount,currency}}, offerCriteria:[...]}` |
| Async handling | `201` only means the command was registered. We poll `GET .../{commandId}` until `completedAt` is set, then read `GET .../{commandId}/tasks` and require task `status == SUCCESS` (documented values: `NEW`, `SUCCESS`, `FAIL`). Timeout produces `WRITE_OUTCOME_UNKNOWN`, never "success". |
| Order status write | `PUT /order/checkout-forms/{id}/fulfillment?checkoutForm.revision=…` body `{status}`; statuses from `CheckoutFormFulfillmentStatus` (`NEW, PROCESSING, READY_FOR_SHIPMENT, READY_FOR_PICKUP, SENT, PICKED_UP, CANCELLED, SUSPENDED`; `RETURNED` is system-set and rejected). Revision gives optimistic concurrency (a stale revision is rejected by Allegro with 409). |
| Offer publish/end | `PUT /sale/offer-publication-commands/{commandId}` body `{publication:{action:"ACTIVATE"|"END"}, offerCriteria:[...]}`; polled like the other commands. Verified by reading back `publication.status` (ACTIVATING is treated as ACTIVE). |
| Pagination | `offset`/`limit` (offers up to 100 per call used here; orders 100) |
| Limits | Allegro enforces per-endpoint limits; the client paces itself at 9 req/s and honours `Retry-After` on 429 for reads. |

## BaseLinker / Base.com API

Source: https://api.baselinker.com/ and per-method pages `?method=<name>` (API "last updated 2026-11-11", read 2026-11-13).

| Topic | What the implementation does |
|---|---|
| Transport | `POST https://api.baselinker.com/connector.php`, form body `method=<name>&parameters=<json>` |
| Auth | `X-BLToken` header (the `token` body field is documented as deprecated and never used) |
| Rate limit | Documented **100 requests/minute**; the client allows 90/min (sliding window) and serialises requests |
| Errors | Failures arrive with **HTTP 200** and `{"status":"ERROR","error_code","error_message"}`; mapped to typed errors (auth / rate limit / permission / not found / validation) |
| Reads | `getInventories`, `getInventoryProductsList` (`include_variants`, 1000/page), `getInventoryProductsStock`, `getInventoryProductsPrices`, `getOrders` (`date_confirmed_from`, 100 per call, cursor on `date_confirmed`), `getOrderStatusList`, `getJournalList` |
| Writes | `updateInventoryProductsStock` (`products:{id:{"bl_<warehouse>":qty}}`; variants addressed by variant id), `updateInventoryProductsPrices` (`{id:{<priceGroupId>:price}}`), `setOrderStatus` |
| Catalogs vs warehouses vs sources | Catalogs (`inventory_id`), warehouses (`bl_123`, `shop_…`, `warehouse_…`) and order sources (`order_source`, `order_source_id`) are modelled separately. Writes **require** an explicit catalog when several exist and an explicit warehouse / price group when several exist. |
| Import linkage | `external_order_id` + `order_source` carry the original marketplace order id (used for Allegro de-duplication). |
| Order note | `setOrderFields` with `admin_comments` (varchar 200). It overwrites, so the connector reads the current comment, appends, refuses if the result exceeds 200 characters and verifies by read-back. |

## WooCommerce REST API

Source: https://developer.woocommerce.com/docs/apis/rest-api/ and the generated reference https://woocommerce.github.io/woocommerce-rest-api-docs/ (read 2026-11-13).

| Topic | What the implementation does |
|---|---|
| Base | `{store}/wp-json/wc/v3/` |
| Auth | REST API **consumer key/secret** via HTTP Basic over HTTPS (OAuth 1.0a is only for plain HTTP, which we do not support in production). These are **not** WordPress Application Passwords, which belong to WooCommerce's separate official MCP integration. |
| Pagination | `per_page` (max 100) / `page`; totals from `X-WP-Total`, `X-WP-TotalPages` |
| Reads | `products` (`search`, `sku`, `status`), `products/{id}`, `products/{id}/variations`, `products/categories`, `orders` (`after`, `before`, `orderby`, `order`), `orders/{id}`, `reports/sales` (`date_min`, `date_max`), `data/currencies/current` |
| Writes | `PUT products/{id}` or `products/{id}/variations/{vid}` (`manage_stock`, `stock_quantity`, `regular_price`), `PUT orders/{id}` (`status`) |
| Variations | Variable parents are rejected as write targets (`AMBIGUOUS_TARGET`); `manage_stock: "parent"` variations report `managed:false` rather than a fake number |
| Prices | `regular_price` is written; an existing `sale_price` is reported as a warning |
| Order note | `POST orders/{id}/notes` with `customer_note:false` (private only) |
| Draft product | `POST products` with `status:"draft"`, `type:"simple"`, mandatory unique `sku`; the proposal is refused if the SKU exists |

### WooCommerce's own MCP

WooCommerce ships an MCP integration (developer preview, https://developer.woocommerce.com/docs/features/mcp/). CommerceWeave is **not** the first WooCommerce MCP server and does not claim to be. It talks to the classic REST API and focuses on one interface across three platforms.

## Live testing status

| Platform | Contract-tested against local servers speaking the documented protocol | Tested against the real service |
|---|---|---|
| Allegro | yes (OAuth refresh, device flow, async commands, revisions) | **no** (no sandbox credentials available when this was written) |
| Base.com | yes (headers, form encoding, 200-with-error, rate-limit error) | **no** |
| WooCommerce | yes (pagination headers, variations, auth) | **no** |

The local servers in `tests/helpers/` are real HTTP servers, not module mocks, but they encode our reading of the documentation. Field-level differences in a live account are possible. Please report any.
