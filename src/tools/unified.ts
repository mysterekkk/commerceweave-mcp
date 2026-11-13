import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { CommerceError } from '../core/errors.js';
import { perConnection } from '../unified/reads.js';
import { findStockDiscrepancies } from '../unified/discrepancies.js';
import { define, EXECUTE_ANNOTATIONS, PROPOSE_ANNOTATIONS, READ_ANNOTATIONS, type Ctx } from './helpers.js';
import { DEMO_NOTICE } from '../demo/index.js';

const connIds = z.array(z.string().max(32)).max(20).optional().describe('Connection ids to include (see commerce_list_connections). Omit for all connections.');
const tz = z.string().max(64).optional().describe('IANA timezone for day boundaries, e.g. Europe/Warsaw. Defaults to the server timezone.');
const pii = z.boolean().default(false).describe('Return buyer names, e-mails and phone numbers. Off by default; only enable when the task truly needs personal data.');
const dateRange = {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('A single local calendar day, YYYY-MM-DD. Omit with no other range = today so far.'),
  days: z.number().int().min(1).max(92).optional().describe('Last N local days including today so far.'),
  from: z.string().max(40).optional().describe('ISO 8601 start (overrides date/days).'),
  to: z.string().max(40).optional().describe('ISO 8601 end.'),
  timezone: tz,
};
const pid = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ids may contain letters, digits, - and _ only');

export function registerUnified(server: McpServer, ctx: Ctx) {
  const { reads, writes, reg, settings } = ctx;

  define(server, {
    name: 'commerce_list_connections', title: 'List commerce connections', annotations: READ_ANNOTATIONS,
    description: 'Lists configured store connections (Allegro, Base.com, WooCommerce) with ids, platform, environment, write capability and the active safety mode. Never returns credentials. Call this first to learn valid connection ids.',
    schema: z.object({}),
    run: async () => {
      const { results, errors } = await perConnection(reg.all(), async (c) => ({ ...(await c.describe()), demo: c.demo, writable: c.writable }));
      return {
        mode: settings.mode, demo: settings.demo, timezoneDefault: settings.timezone,
        connections: results.map((r) => r.value), errors,
        notice: settings.demo ? DEMO_NOTICE : undefined,
        hint: reg.all().length === 0 ? 'No connections configured. Set COMMERCEWEAVE_DEMO=true to try synthetic data, or configure ALLEGRO_/BASE_/WOO_ variables (see README).' : undefined,
      };
    },
  });

  define(server, {
    name: 'commerce_list_products', title: 'List products across stores', annotations: READ_ANNOTATIONS, untrusted: true,
    description: 'Lists products/offers in a normalized shape (source ids, SKU, EAN, gross prices, stock, variants). Pages are per connection: one connection per call is recommended for large catalogs. Stock `total` is null when the platform does not manage a quantity. Base prices carry no currency (null).',
    schema: z.object({ connectionIds: connIds, query: z.string().max(200).optional().describe('Name substring filter.'), limit: z.number().int().min(1).max(100).default(25), page: z.number().int().min(1).max(1000).default(1), includeVariants: z.boolean().default(true) }),
    run: async (a, signal) => {
      const { results, errors } = await perConnection(reg.select(a.connectionIds), (c) => c.listProducts({ limit: a.limit, page: a.page, query: a.query, includeVariants: a.includeVariants }, signal));
      return { page: a.page, connections: results.map((r) => ({ connectionId: r.connection.id, platform: r.connection.platform, total: r.value.total, hasMore: r.value.hasMore, warnings: r.value.warnings, products: r.value.products })), errors, complete: errors.length === 0 };
    },
  });

  define(server, {
    name: 'commerce_find_product', title: 'Find a product by SKU, EAN or name', annotations: READ_ANNOTATIONS, untrusted: true,
    description: 'Looks for the same product on several platforms by SKU, EAN or name. SKU matches are exact; name search is a substring match. Matches are candidates only: SKUs may be missing or reused, so confirm identity before using a result as a write target.',
    schema: z.object({ sku: z.string().max(80).optional(), ean: z.string().max(32).optional(), query: z.string().max(200).optional(), connectionIds: connIds }).refine((v) => v.sku || v.ean || v.query, 'Provide sku, ean or query'),
    run: (a, signal) => reads.findProduct(a, signal),
  });

  define(server, {
    name: 'commerce_list_orders', title: 'List orders across stores', annotations: READ_ANNOTATIONS, untrusted: true,
    description: 'Lists orders from all (or selected) connections for a local day, last N days, or an explicit range, normalized and de-duplicated: orders imported from another platform are flagged with `duplicate` (status "confirmed" = same sale proven by ids, "potential" = unproven). Personal data is masked unless includePersonalData=true. `complete` is false if any connection failed or results were truncated.',
    schema: z.object({ connectionIds: connIds, ...dateRange, includePersonalData: pii, maxPerConnection: z.number().int().min(1).max(500).default(200) }),
    run: async (a, signal) => {
      const r = await reads.orders({ ...a, includePersonalData: a.includePersonalData }, signal);
      const confirmed = r.orders.filter((o) => o.duplicate?.status === 'confirmed').length;
      const potential = r.orders.filter((o) => o.duplicate?.status === 'potential').length;
      return { period: { from: r.range.from.toISOString(), to: r.range.to.toISOString(), label: r.range.label, timezone: r.range.timezone }, orderCount: r.orders.length, confirmedDuplicates: confirmed, potentialDuplicates: potential, orders: r.orders, errors: r.errors, warnings: r.warnings, complete: r.complete, personalDataRedacted: !a.includePersonalData };
    },
  });

  define(server, {
    name: 'commerce_get_order', title: 'Get one order', annotations: READ_ANNOTATIONS, untrusted: true,
    description: 'Fetches one order by its platform id from a specific connection, normalized. Personal data is masked unless includePersonalData=true.',
    schema: z.object({ connectionId: z.string().max(32), orderId: pid, includePersonalData: pii }),
    run: async (a, signal) => ({ order: await reg.get(a.connectionId).getOrder(a.orderId, a.includePersonalData, signal) }),
  });

  define(server, {
    name: 'commerce_low_stock', title: 'Find products running low', annotations: READ_ANNOTATIONS,
    description: 'Lists sellable items (variants individually) with stock <= threshold on each connection, lowest first. Items whose platform does not manage a quantity are skipped and counted, never treated as zero. Reports which connections were incomplete or failed.',
    schema: z.object({ threshold: z.number().int().min(0).max(100000).default(5), connectionIds: connIds, maxItemsPerConnection: z.number().int().min(10).max(5000).default(1000) }),
    run: (a, signal) => reads.lowStock(a, signal),
  });

  define(server, {
    name: 'commerce_inventory_report', title: 'Inventory overview per store', annotations: READ_ANNOTATIONS,
    description: 'Per-connection inventory summary: number of sellable items, total units, out-of-stock, low-stock and unmanaged counts. Units are not summed across platforms because the same stock may be published in several places.',
    schema: z.object({ connectionIds: connIds, lowThreshold: z.number().int().min(0).max(100000).default(5), maxItemsPerConnection: z.number().int().min(10).max(5000).default(1000) }),
    run: (a, signal) => reads.inventoryReport(a, signal),
  });

  define(server, {
    name: 'commerce_sales_summary', title: 'Sales summary without double counting', annotations: READ_ANNOTATIONS,
    description: 'Gross revenue and order counts per currency and connection for a period. Confirmed imported duplicates (e.g. Base orders imported from Allegro) are excluded; potential duplicates are included but reported separately. Cancelled, refunded and (by default) unpaid orders are excluded. This is revenue, not profit; currencies are never converted.',
    schema: z.object({ connectionIds: connIds, ...dateRange, includeUnpaid: z.boolean().default(false), maxPerConnection: z.number().int().min(1).max(2000).default(1000) }),
    run: (a, signal) => reads.salesSummary({ ...a, includePersonalData: false }, signal),
  });

  define(server, {
    name: 'commerce_find_stock_discrepancies', title: 'Compare stock across stores', annotations: READ_ANNOTATIONS,
    description: 'Compares stock for the same product on several connections. Pairs items by explicit config mapping first, then by SKU/EAN only when unique in each store; ambiguous or unmatched items are listed rather than guessed. Changes nothing. Optionally pass sourceOfTruth (a connection id) to get suggested updates, which can be turned into a reviewable proposal with commerce_prepare_stock_update.',
    schema: z.object({ connectionIds: connIds, sourceOfTruth: z.string().max(32).optional(), maxItemsPerConnection: z.number().int().min(10).max(5000).default(1000) }),
    run: (a, signal) => findStockDiscrepancies(reg, { ...a, skuMap: settings.skuMap }, signal),
  });

  if (settings.mode === 'read_only') return;

  const itemStock = z.object({ productId: pid, variantId: pid.optional().describe('Required for variable products.'), catalogId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional().describe('Base catalog id; required when the Base account has several.'), locationId: z.string().max(32).optional().describe('Base warehouse id like bl_123; required when several warehouses hold stock.'), quantity: z.number().int().min(0).max(1_000_000).describe('New absolute stock quantity.') });
  define(server, {
    name: 'commerce_prepare_stock_update', title: 'Prepare a stock change (no write)', annotations: PROPOSE_ANNOTATIONS,
    description: 'Reads current stock, then records a reviewable proposal with before/after values. NOTHING IS CHANGED ON THE PLATFORM. connectionId is mandatory. Targets that are ambiguous (variable product without variantId, several Base warehouses/catalogs) are rejected. A human must approve the exact plan out-of-band before it can run.',
    schema: z.object({ connectionId: z.string().max(32), items: z.array(itemStock).min(1).max(25) }),
    run: (a, signal) => writes.prepareStock(a.connectionId, a.items, signal),
  });

  const itemPrice = z.object({ productId: pid, variantId: pid.optional(), catalogId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(), priceGroup: z.string().max(32).optional().describe('Base price group id; required when several exist.'), newPrice: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).optional().describe('Exact new gross price as a decimal string, e.g. "49.90".'), changePercent: z.string().regex(/^-?\d{1,3}(\.\d{1,4})?$/).optional().describe('Percent change applied to the CURRENT price, e.g. "5" or "-2.5". Rounded half-up to 2 decimals.') });
  define(server, {
    name: 'commerce_prepare_price_update', title: 'Prepare a price change (no write)', annotations: PROPOSE_ANNOTATIONS,
    description: 'Computes new prices with exact decimal arithmetic from the live current price (newPrice or changePercent per item) and records a reviewable proposal with before/after and the difference. NOTHING IS CHANGED ON THE PLATFORM. Woo changes the regular price only (warns if a sale price exists). A human must approve the exact plan out-of-band.',
    schema: z.object({ connectionId: z.string().max(32), items: z.array(itemPrice).min(1).max(25) }),
    run: (a, signal) => writes.preparePrice(a.connectionId, a.items, signal),
  });

  define(server, {
    name: 'commerce_prepare_order_status_update', title: 'Prepare an order status change (no write)', annotations: PROPOSE_ANNOTATIONS,
    description: 'Validates the target status against the platform (Allegro fulfillment status, Base status id, Woo status), reads the current status and records a reviewable proposal. NOTHING IS CHANGED ON THE PLATFORM. A human must approve the exact plan out-of-band.',
    schema: z.object({ connectionId: z.string().max(32), orderId: pid, status: z.string().min(1).max(64) }),
    run: (a, signal) => writes.prepareOrderStatus(a.connectionId, a.orderId, a.status, signal),
  });

  define(server, {
    name: 'commerce_prepare_order_note', title: 'Prepare an internal order note (no write)', annotations: PROPOSE_ANNOTATIONS,
    description: 'Records a proposal to add a short internal note (max 190 chars, plain text) to an order. WooCommerce: private staff note, never sent to the customer. Base.com: appended to the seller comment (200 char limit). Allegro is not supported. NOTHING IS CHANGED ON THE PLATFORM until a human approves.',
    schema: z.object({ connectionId: z.string().max(32), orderId: pid, note: z.string().min(1).max(190) }),
    run: (a, signal) => writes.prepareOrderNote(a.connectionId, a.orderId, a.note, signal),
  });

  define(server, {
    name: 'commerce_get_proposal', title: 'Show a proposal', annotations: READ_ANNOTATIONS,
    description: 'Shows a stored proposal: plan, status (pending/executing/executed/failed), expiry and execution result.',
    schema: z.object({ proposalId: z.string().regex(/^cw_[a-z0-9]{12}$/) }),
    run: async (a) => writes.describe(ctx.store.get(a.proposalId)),
  });

  if (settings.mode !== 'approval_required') return;
  define(server, {
    name: 'commerce_execute_proposal', title: 'Execute a human-approved proposal', annotations: EXECUTE_ANNOTATIONS,
    description: 'Executes a proposal ONLY if a human approved that exact plan in a separate terminal (`commerceweave-mcp approve <id>`). There is no way for the model to grant approval. Re-reads live state first and aborts if anything drifted; runs once; verifies results by reading back; writes an audit entry.',
    schema: z.object({ proposalId: z.string().regex(/^cw_[a-z0-9]{12}$/) }),
    run: (a, signal) => {
      if (!a.proposalId) throw new CommerceError('VALIDATION_FAILED', 'proposalId required');
      return writes.execute(a.proposalId, signal);
    },
  });
}
