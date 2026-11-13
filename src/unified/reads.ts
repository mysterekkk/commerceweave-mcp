import type { Connector } from '../connectors/types.js';
import type { Registry } from '../connectors/registry.js';
import { toCommerceError } from '../core/errors.js';
import { addDecimal } from './util.js';
import { formatDecimal, parseDecimal } from '../core/money.js';
import type { CommerceOrder, CommerceProduct, CommerceVariant } from '../core/models.js';
import { resolveRange } from '../core/time.js';
import { countsInSales, markDuplicates } from './dedupe.js';

export interface PartialError { connectionId: string; code: string; message: string }

/** Runs `fn` for each connection; one failing platform never hides the others. */
export async function perConnection<T>(conns: Connector[], fn: (c: Connector) => Promise<T>): Promise<{ results: Array<{ connection: Connector; value: T }>; errors: PartialError[] }> {
  const results: Array<{ connection: Connector; value: T }> = [];
  const errors: PartialError[] = [];
  for (const c of conns) {
    try {
      results.push({ connection: c, value: await fn(c) });
    } catch (e) {
      const ce = toCommerceError(e);
      errors.push({ connectionId: c.id, code: ce.code, message: ce.message });
    }
  }
  return { results, errors };
}

export interface Leaf { connectionId: string; platform: string; productId: string; variantId?: string; sku: string | null; ean: string | null; name: string; total: number | null; managed: boolean; status: string; currency: string | null; price: string | null; byLocation?: Record<string, number>; catalogId?: string }

export function leaves(p: CommerceProduct): Leaf[] {
  const mk = (x: CommerceProduct | CommerceVariant, parent?: CommerceProduct): Leaf => ({
    connectionId: x.source.connectionId, platform: x.source.platform, productId: parent ? parent.source.externalId : x.source.externalId,
    variantId: parent ? x.source.externalId : undefined, sku: x.sku, ean: x.ean, name: parent ? `${parent.name} — ${x.name ?? ''}` : (x as CommerceProduct).name,
    total: x.inventory.total, managed: x.inventory.managed, status: x.inventory.status, currency: x.prices[0]?.currency ?? null, price: x.prices[0]?.amount ?? null,
    byLocation: x.inventory.byLocation, catalogId: (parent ?? x).source.extra?.catalogId,
  });
  return p.variants?.length ? p.variants.map((v) => mk(v, p)) : [mk(p)];
}

export async function fetchAllProducts(c: Connector, max: number, signal?: AbortSignal): Promise<{ products: CommerceProduct[]; complete: boolean; warnings: string[] }> {
  const products: CommerceProduct[] = [];
  const warnings: string[] = [];
  let page = 1;
  for (;;) {
    const r = await c.listProducts({ limit: 100, page, includeVariants: true }, signal);
    products.push(...r.products);
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    if (!r.hasMore) return { products, complete: true, warnings };
    if (products.length >= max) return { products: products.slice(0, max), complete: false, warnings };
    page++;
  }
}

export class Reads {
  constructor(private readonly reg: Registry, private readonly timezone: string) {}

  async orders(a: { connectionIds?: string[]; date?: string; days?: number; from?: string; to?: string; timezone?: string; includePersonalData: boolean; maxPerConnection: number }, signal?: AbortSignal) {
    const range = resolveRange({ ...a, timezone: a.timezone ?? this.timezone });
    const conns = this.reg.select(a.connectionIds);
    const { results, errors } = await perConnection(conns, (c) => c.listOrders({ from: range.from, to: range.to, includePersonalData: a.includePersonalData, maxOrders: a.maxPerConnection }, signal));
    const warnings: string[] = [];
    let all: CommerceOrder[] = [];
    let truncated = false;
    for (const r of results) {
      all.push(...r.value.orders);
      warnings.push(...r.value.warnings.map((w) => `[${r.connection.id}] ${w}`));
      truncated ||= r.value.truncated;
    }
    all = markDuplicates(all).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    return { range, orders: all, errors, warnings, complete: errors.length === 0 && !truncated };
  }

  async salesSummary(a: Parameters<Reads['orders']>[0] & { includeUnpaid: boolean }, signal?: AbortSignal) {
    const r = await this.orders(a, signal);
    const byCur = new Map<string, { gross: bigint; orders: number; potentialDupOrders: number; potentialDupGross: bigint; uncertainStatusOrders: number; perConnection: Map<string, { gross: bigint; orders: number }> }>();
    const excluded: Record<string, number> = {};
    for (const o of r.orders) {
      const v = countsInSales(o, a.includeUnpaid);
      if (!v.counted) { excluded[v.reason as string] = (excluded[v.reason as string] ?? 0) + 1; continue; }
      const cur = o.total.currency || 'UNKNOWN';
      const e = byCur.get(cur) ?? { gross: 0n, orders: 0, potentialDupOrders: 0, potentialDupGross: 0n, uncertainStatusOrders: 0, perConnection: new Map() };
      const amt = parseDecimal(o.total.amount);
      e.gross = addDecimal(e.gross, amt);
      e.orders++;
      if (o.duplicate?.status === 'potential') { e.potentialDupOrders++; e.potentialDupGross += amt; }
      if (!o.stateClassified) e.uncertainStatusOrders++;
      const pc = e.perConnection.get(o.source.connectionId) ?? { gross: 0n, orders: 0 };
      pc.gross += amt; pc.orders++;
      e.perConnection.set(o.source.connectionId, pc);
      byCur.set(cur, e);
    }
    const notes = [
      'Amounts are gross order values as reported by each platform (include VAT and delivery). This is revenue, NOT profit and not net of fees or refunds.',
      'Currencies are never converted or mixed; each currency is reported separately.',
      'Orders confirmed as imported copies (e.g. Base orders imported from Allegro) are excluded to avoid double counting.',
    ];
    if (!a.includeUnpaid) notes.push('Unpaid / awaiting-payment orders are excluded (set includeUnpaid=true to include them).');
    return {
      period: { from: r.range.from.toISOString(), to: r.range.to.toISOString(), label: r.range.label, timezone: r.range.timezone },
      currencies: [...byCur].map(([currency, e]) => ({
        currency, grossRevenue: formatDecimal(e.gross, 2), orderCount: e.orders,
        potentialDuplicates: { orders: e.potentialDupOrders, gross: formatDecimal(e.potentialDupGross, 2), note: e.potentialDupOrders ? 'Included in the total above; they may be the same sales seen on two platforms. Subtract if confirmed.' : undefined },
        ordersWithUnclassifiedStatus: e.uncertainStatusOrders,
        byConnection: [...e.perConnection].map(([connectionId, v]) => ({ connectionId, orderCount: v.orders, grossRevenue: formatDecimal(v.gross, 2) })),
      })),
      excludedOrders: excluded, notes, errors: r.errors, warnings: r.warnings,
      complete: r.complete,
      incompleteReason: r.complete ? undefined : [...(r.errors.length ? ['some connections failed'] : []), ...(r.warnings.some((w) => /truncated/i.test(w)) ? ['order list truncated'] : [])].join('; '),
    };
  }

  async lowStock(a: { connectionIds?: string[]; threshold: number; maxItemsPerConnection: number }, signal?: AbortSignal) {
    const { results, errors } = await perConnection(this.reg.select(a.connectionIds), (c) => fetchAllProducts(c, a.maxItemsPerConnection, signal));
    const items: Array<Leaf & { total: number }> = [];
    let unmanaged = 0;
    const incomplete: string[] = [];
    for (const r of results) {
      if (!r.value.complete) incomplete.push(r.connection.id);
      for (const p of r.value.products) for (const l of leaves(p)) {
        if (l.total === null) { unmanaged++; continue; }
        if (l.total <= a.threshold) items.push(l as Leaf & { total: number });
      }
    }
    items.sort((x, y) => x.total - y.total);
    return {
      threshold: a.threshold, count: items.length, items, unmanagedItemsSkipped: unmanaged, errors,
      notes: ['Quantity is per connection (Base: summed across its warehouses; see byLocation). Items whose platform does not manage a quantity are skipped, not treated as zero.', 'The same physical product sold on several platforms appears once per platform.'],
      complete: errors.length === 0 && incomplete.length === 0,
      incompleteConnections: incomplete,
    };
  }

  async inventoryReport(a: { connectionIds?: string[]; lowThreshold: number; maxItemsPerConnection: number }, signal?: AbortSignal) {
    const { results, errors } = await perConnection(this.reg.select(a.connectionIds), (c) => fetchAllProducts(c, a.maxItemsPerConnection, signal));
    const rows = results.map(({ connection, value }) => {
      let skus = 0, units = 0, out = 0, low = 0, unmanaged = 0;
      for (const p of value.products) for (const l of leaves(p)) {
        skus++;
        if (l.total === null) { unmanaged++; continue; }
        units += l.total;
        if (l.total <= 0) out++; else if (l.total <= a.lowThreshold) low++;
      }
      return { connectionId: connection.id, platform: connection.platform, demo: connection.demo, sellableItems: skus, totalUnits: units, outOfStock: out, lowStock: low, unmanaged, complete: value.complete };
    });
    return { lowThreshold: a.lowThreshold, connections: rows, errors, notes: ['Units are not summed across platforms because the same stock may be published on several of them.'] };
  }

  async findProduct(a: { sku?: string; ean?: string; query?: string; connectionIds?: string[] }, signal?: AbortSignal) {
    const { results, errors } = await perConnection(this.reg.select(a.connectionIds), async (c) => {
      const r = await c.listProducts({ limit: 50, page: 1, sku: a.sku, ean: a.ean, query: a.query, includeVariants: true }, signal);
      return r.products.filter((p) => {
        const ls = leaves(p);
        if (a.sku) return ls.some((l) => l.sku === a.sku) || p.sku === a.sku;
        if (a.ean) return ls.some((l) => l.ean === a.ean);
        return true;
      });
    });
    const matches = results.flatMap((r) => r.value.map((p) => ({ connectionId: r.connection.id, platform: r.connection.platform, matchedBy: a.sku ? 'sku' : a.ean ? 'ean' : 'name', product: p })));
    return { matches, errors, notes: ['SKU is not guaranteed unique or present on every platform; confirm identity before using a match as a write target.'] };
  }
}

export type { Connector };
