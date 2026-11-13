import type { BaseConfig } from '../../core/config.js';
import { CommerceError } from '../../core/errors.js';
import { HttpClient } from '../../core/http.js';
import { formatDecimal, normalizeMoney, parseDecimal } from '../../core/money.js';
import type { CommerceOrder, CommerceProduct, CommerceStore, OrderState } from '../../core/models.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { maskEmail, maskName, maskPhone } from '../../core/redact.js';
import type { Connector, CurrentState, ListOrdersQuery, ListProductsQuery, OrderPage, ProductPage, WriteOperation, WriteResult } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export const BASE_DEFAULT_URL = 'https://api.baselinker.com/connector.php';

/** Maps documented Base API failures (returned with HTTP 200) to typed errors. */
export function baseApiError(connectionId: string, method: string, code: string, message: string): CommerceError {
  const text = `${code} ${message}`;
  const d = { connectionId };
  if (/limit|blocked|too many/i.test(text)) return new CommerceError('RATE_LIMITED', `Base API rate limit on ${method}: ${message}`, d);
  if (/auth|token|login/i.test(text)) return new CommerceError('AUTH_FAILED', `Base API rejected the token (${method}): ${message}`, d);
  if (/permission|denied|access/i.test(text)) return new CommerceError('PERMISSION_DENIED', `Base API permission error (${method}): ${message}`, d);
  if (/not.?found|no such/i.test(text)) return new CommerceError('NOT_FOUND', `Base API (${method}): ${message}`, d);
  return new CommerceError('VALIDATION_FAILED', `Base API error on ${method} [${code}]: ${message}`, d);
}

/** Base ids are plain integers. Reject anything else instead of letting Number() turn it into NaN or another id. */
export function intId(v: string | undefined, what: string): number {
  if (v === undefined || !/^[0-9]{1,12}$/.test(v)) throw new CommerceError('VALIDATION_FAILED', `${what} must be a plain integer for Base.com (got ${JSON.stringify(v)})`);
  return Number(v);
}

export class BaseConnector implements Connector {
  readonly platform = 'baselinker' as const;
  readonly demo = false;
  readonly id: string;
  private readonly http: HttpClient;
  private statusNames?: Map<string, string>;
  private inventoriesCache?: J[];

  constructor(private readonly cfg: BaseConfig, public readonly writable: boolean, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
    this.id = cfg.id;
    this.http = new HttpClient({
      connectionId: cfg.id,
      baseUrl: cfg.apiUrl ?? BASE_DEFAULT_URL,
      // Documented limit: 100 requests/minute. Stay below it.
      limiter: new RateLimiter(90, 60_000),
      sleep: opts.sleep,
      defaultHeaders: () => ({ 'X-BLToken': cfg.token, Accept: 'application/json' }),
    });
  }

  /** One API call. `write` calls are never retried. */
  async call<T = J>(method: string, params: Record<string, unknown>, write = false, signal?: AbortSignal): Promise<T> {
    const body = new URLSearchParams({ method, parameters: JSON.stringify(params) });
    const r = await this.http.request<J>({
      method: 'POST', path: '', body, contentType: 'application/x-www-form-urlencoded', idempotent: !write, signal,
    });
    const d = r.data;
    if (!d || typeof d !== 'object') throw new CommerceError('UPSTREAM_ERROR', `Base API returned a non-JSON response for ${method}`, { connectionId: this.id });
    if (d.status === 'ERROR') throw baseApiError(this.id, method, String(d.error_code ?? ''), String(d.error_message ?? ''));
    return d as T;
  }

  private async inventories(signal?: AbortSignal): Promise<J[]> {
    if (!this.inventoriesCache) {
      const r = await this.call<J>('getInventories', {}, false, signal);
      const all: J[] = r.inventories ?? [];
      this.inventoriesCache = this.cfg.inventoryIds ? all.filter((i) => this.cfg.inventoryIds?.includes(String(i.inventory_id))) : all;
    }
    return this.inventoriesCache;
  }

  async describe(): Promise<CommerceStore> {
    const inv = await this.inventories();
    return {
      connectionId: this.id, platform: this.platform, environment: 'production', storeLabel: 'Base.com',
      catalogs: inv.map((i) => ({ id: String(i.inventory_id), name: String(i.name), warehouses: (i.warehouses ?? []).map(String) })),
    };
  }

  async getStockRaw(inventoryId: string, productId?: string, page = 1, signal?: AbortSignal) {
    const r = await this.call<J>('getInventoryProductsStock', { inventory_id: intId(inventoryId, 'catalogId'), page, ...(productId ? { filter_id: intId(productId, 'productId') } : {}) }, false, signal);
    return Object.values(r.products ?? {}) as J[];
  }

  async getPricesRaw(inventoryId: string, page = 1, signal?: AbortSignal) {
    const r = await this.call<J>('getInventoryProductsPrices', { inventory_id: intId(inventoryId, 'catalogId'), page }, false, signal);
    return Object.values(r.products ?? {}) as J[];
  }

  async getJournal(lastLogId: number, orderId?: string, types?: number[], signal?: AbortSignal) {
    const r = await this.call<J>('getJournalList', { last_log_id: lastLogId, ...(orderId ? { order_id: intId(orderId, 'orderId') } : {}), ...(types ? { logs_types: types } : {}) }, false, signal);
    return (r.logs ?? []).map((l: J) => ({ logId: Number(l.log_id ?? l.id), orderId: String(l.order_id), type: Number(l.log_type), objectId: String(l.object_id ?? ''), at: new Date(Number(l.date) * 1000).toISOString() }));
  }

  async listCatalogs(signal?: AbortSignal) {
    return (await this.inventories(signal)).map((i) => ({ id: String(i.inventory_id), name: String(i.name), isDefault: !!i.is_default, warehouses: (i.warehouses ?? []).map(String), priceGroups: (i.price_groups ?? []).map(String), defaultPriceGroup: i.default_price_group ? String(i.default_price_group) : null, defaultWarehouse: i.default_warehouse ? String(i.default_warehouse) : null, reservations: !!i.reservations }));
  }

  async orderStatuses(signal?: AbortSignal) {
    if (!this.statusNames) {
      const r = await this.call<J>('getOrderStatusList', {}, false, signal);
      this.statusNames = new Map((r.statuses ?? []).map((s: J) => [String(s.id), String(s.name)]));
    }
    return [...this.statusNames].map(([id, name]) => ({ id, name }));
  }

  private classify(statusId: string): { state: OrderState; classified: boolean } {
    const s = this.cfg.statusMap?.[statusId];
    return s ? { state: s, classified: true } : { state: 'unknown', classified: false };
  }

  async listProducts(q: ListProductsQuery, signal?: AbortSignal): Promise<ProductPage> {
    const invs = await this.inventories(signal);
    const targets = q.catalogId ? invs.filter((i) => String(i.inventory_id) === q.catalogId) : invs;
    if (q.catalogId && targets.length === 0) throw new CommerceError('NOT_FOUND', `Base catalog ${q.catalogId} not found on connection ${this.id}`, { connectionId: this.id });
    const warnings: string[] = [];
    if (targets.length > 1) warnings.push(`Connection ${this.id} has ${targets.length} catalogs; results come from all of them (see source.extra.catalogId).`);
    const products: CommerceProduct[] = [];
    let hasMore = false;
    for (const inv of targets) {
      const r = await this.call<J>('getInventoryProductsList', {
        inventory_id: Number(inv.inventory_id), page: q.page, include_variants: true,
        ...(q.sku ? { filter_sku: q.sku } : {}), ...(q.ean ? { filter_ean: q.ean } : {}), ...(q.query ? { filter_name: q.query } : {}),
      }, false, signal);
      const rows: J[] = Object.values(r.products ?? {});
      if (rows.length >= 1000) hasMore = true;
      const catalogId = String(inv.inventory_id);
      const currency: string | null = null;
      const mk = (p: J): CommerceProduct => {
        const stock: Record<string, number> = Object.fromEntries(Object.entries(p.stock ?? {}).map(([k, v]) => [k, Number(v)]));
        const total = Object.values(stock).reduce((a, b) => a + b, 0);
        return {
          source: { connectionId: this.id, platform: this.platform, externalId: String(p.id), extra: { catalogId, ...(p.parent_id ? { parentId: String(p.parent_id) } : {}) } },
          sku: p.sku || null, ean: p.ean || null, name: String(p.name ?? ''), kind: p.parent_id ? 'variant' : 'simple', status: null,
          prices: Object.entries(p.prices ?? {}).map(([g, v]) => ({ amount: normalizeMoney(v as number), currency, group: g })),
          inventory: { total, managed: true, status: total > 0 ? 'in_stock' : 'out_of_stock', byLocation: stock },
        };
      };
      const parents = new Map<string, CommerceProduct>();
      const variants: J[] = [];
      for (const p of rows) { if (p.parent_id) variants.push(p); else parents.set(String(p.id), mk(p)); }
      for (const v of variants) {
        const parent = parents.get(String(v.parent_id));
        const mv = mk(v);
        if (parent) {
          parent.kind = 'variable';
          (parent.variants ??= []).push({ source: mv.source, sku: mv.sku, ean: mv.ean, name: mv.name, prices: mv.prices, inventory: mv.inventory });
        } else parents.set(String(v.id), mv);
      }
      products.push(...parents.values());
    }
    warnings.push('Base prices are gross per price group; currency is defined by the Base price group and is not returned by the API (currency is null).');
    return { products: products.slice(0, q.limit), total: null, hasMore: hasMore || products.length > q.limit, warnings };
  }

  private toOrder(o: J, pii: boolean): CommerceOrder {
    const items = (o.products ?? []).map((p: J) => ({
      name: String(p.name), sku: p.sku || null, externalProductId: p.product_id ? String(p.product_id) : null,
      externalVariantId: p.variant_id ? String(p.variant_id) : null, quantity: Number(p.quantity),
      unitPrice: { amount: normalizeMoney(p.price_brutto ?? 0), currency: String(o.currency) },
    }));
    let total = parseDecimal(o.delivery_price ?? 0);
    for (const p of o.products ?? []) total += parseDecimal(p.price_brutto ?? 0) * BigInt(Math.round(Number(p.quantity)));
    const { state, classified } = this.classify(String(o.order_status_id));
    const name = String(o.delivery_fullname || o.invoice_fullname || '');
    const imported = o.external_order_id && o.order_source && !['personal', 'order_return'].includes(o.order_source);
    return {
      source: { connectionId: this.id, platform: this.platform, externalId: String(o.order_id), extra: { orderSource: String(o.order_source ?? ''), orderSourceId: String(o.order_source_id ?? ''), ...(o.shop_order_id ? { shopOrderId: String(o.shop_order_id) } : {}) } },
      createdAt: new Date(Number(o.date_add) * 1000).toISOString(),
      platformStatus: String(o.order_status_id), state, stateClassified: classified,
      total: { amount: formatDecimal(total, 2), currency: String(o.currency) },
      items,
      customer: pii
        ? { name: name || undefined, email: o.email || undefined, phone: o.phone || undefined, login: o.user_login || undefined, redacted: false }
        : { name: maskName(name), email: maskEmail(o.email), phone: maskPhone(o.phone), login: o.user_login ? `${String(o.user_login).slice(0, 1)}***` : undefined, redacted: true },
      importedFrom: imported ? { system: String(o.order_source), externalOrderId: String(o.external_order_id) } : undefined,
      untrustedText: o.user_comments ? { buyerNote: pii ? String(o.user_comments).slice(0, 500) : '[redacted — request includePersonalData]' } : undefined,
    };
  }

  async listOrders(q: ListOrdersQuery, signal?: AbortSignal): Promise<OrderPage> {
    const orders: CommerceOrder[] = [];
    let cursor = Math.floor(q.from.getTime() / 1000);
    const toTs = Math.floor(q.to.getTime() / 1000);
    let truncated = false;
    for (;;) {
      const r = await this.call<J>('getOrders', { date_confirmed_from: cursor, get_unconfirmed_orders: false, include_custom_extra_fields: false }, false, signal);
      const rows: J[] = r.orders ?? [];
      for (const o of rows) {
        if (Number(o.date_add) <= toTs && Number(o.date_add) >= Math.floor(q.from.getTime() / 1000)) orders.push(this.toOrder(o, q.includePersonalData));
      }
      if (rows.length < 100) break;
      const last = Number(rows[rows.length - 1].date_confirmed);
      if (last >= toTs) break;
      if (orders.length >= q.maxOrders) { truncated = true; break; }
      cursor = last + 1;
    }
    if (orders.length > q.maxOrders) { orders.length = q.maxOrders; truncated = true; }
    return { orders, truncated, warnings: truncated ? [`Result truncated at ${q.maxOrders} orders.`] : [] };
  }

  async getOrder(orderId: string, pii: boolean, signal?: AbortSignal): Promise<CommerceOrder> {
    const r = await this.call<J>('getOrders', { order_id: intId(orderId, 'orderId'), get_unconfirmed_orders: true }, false, signal);
    const o = (r.orders ?? [])[0];
    if (o && String(o.order_id) !== String(orderId)) throw new CommerceError('UPSTREAM_ERROR', `Base returned order ${o.order_id} for requested ${orderId}`, { connectionId: this.id });
    if (!o) throw new CommerceError('NOT_FOUND', `Base order ${orderId} not found`, { connectionId: this.id });
    return this.toOrder(o, pii);
  }

  private async pickInventory(op: { catalogId?: string }, signal?: AbortSignal): Promise<string> {
    const invs = await this.inventories(signal);
    if (op.catalogId) {
      if (!invs.some((i) => String(i.inventory_id) === op.catalogId)) throw new CommerceError('NOT_FOUND', `Catalog ${op.catalogId} is not available on ${this.id}`, { connectionId: this.id });
      return op.catalogId;
    }
    if (invs.length === 1) return String(invs[0].inventory_id);
    throw new CommerceError('AMBIGUOUS_TARGET', `Connection ${this.id} has ${invs.length} catalogs (${invs.map((i) => i.inventory_id).join(', ')}); specify catalogId.`, { connectionId: this.id });
  }

  /** Resolves catalog, price group and (if stock is given) warehouse; several candidates must be chosen explicitly. */
  private async draftTarget(op: Extract<WriteOperation, { kind: 'product_draft' }>, signal?: AbortSignal) {
    const inventory = await this.pickInventory(op, signal);
    const inv = (await this.inventories(signal)).find((i) => String(i.inventory_id) === inventory) as J;
    const groups: string[] = (inv.price_groups ?? []).map(String);
    const priceGroup = op.priceGroup ?? (groups.length === 1 ? groups[0] : undefined);
    if (!priceGroup) throw new CommerceError('AMBIGUOUS_TARGET', `Catalog ${inventory} has ${groups.length} price groups (${groups.join(', ')}); specify priceGroup.`, { connectionId: this.id });
    if (!groups.includes(priceGroup)) throw new CommerceError('NOT_FOUND', `Price group ${priceGroup} is not part of catalog ${inventory}`, { connectionId: this.id });
    let warehouse: string | undefined;
    if (op.stockQuantity !== undefined) {
      const whs: string[] = (inv.warehouses ?? []).map(String).filter((w: string) => w.startsWith('bl_'));
      warehouse = op.locationId ?? (whs.length === 1 ? whs[0] : undefined);
      if (!warehouse) throw new CommerceError('AMBIGUOUS_TARGET', `Catalog ${inventory} has ${whs.length} stock-editable warehouses (${whs.join(', ')}); specify locationId.`, { connectionId: this.id });
      if (!whs.includes(warehouse)) throw new CommerceError('NOT_FOUND', `Warehouse ${warehouse} is not editable in catalog ${inventory}`, { connectionId: this.id });
    }
    return { inventory, priceGroup, warehouse };
  }

  async readCurrent(op: WriteOperation, signal?: AbortSignal): Promise<CurrentState> {
    if (op.kind === 'offer_publication') throw new CommerceError('NOT_SUPPORTED', 'Offer publication is an Allegro concept.', { connectionId: this.id });
    if (op.kind === 'product_draft') {
      const t = await this.draftTarget(op, signal);
      const r = await this.call<J>('getInventoryProductsList', { inventory_id: intId(t.inventory, 'catalogId'), filter_sku: op.sku }, false, signal);
      const exists = Object.values(r.products ?? {}).some((p) => (p as J).sku === op.sku);
      return {
        value: exists ? 'exists' : 'absent', noteAfter: 'exists', description: `product with SKU "${op.sku}" in Base catalog ${t.inventory}`, currency: null,
        warnings: [
          exists ? 'A product with this SKU already exists in the catalog; creation will be refused.' : `Creates a catalog product in Base catalog ${t.inventory} (price group ${t.priceGroup}${op.stockQuantity !== undefined ? `, warehouse ${t.warehouse}` : ''}). It is not linked to any marketplace or shop listing.`,
          'VAT rate and other attributes are left to the catalog defaults; the price currency is defined by the Base price group.',
        ],
      };
    }
    if (op.kind === 'order_note') {
      const r = await this.call<J>('getOrders', { order_id: intId(op.orderId, 'orderId'), get_unconfirmed_orders: true }, false, signal);
      const o = (r.orders ?? [])[0];
      if (o && String(o.order_id) !== String(op.orderId)) throw new CommerceError('UPSTREAM_ERROR', `Base returned order ${o.order_id} for requested ${op.orderId}`, { connectionId: this.id });
      if (!o) throw new CommerceError('NOT_FOUND', `Base order ${op.orderId} not found`, { connectionId: this.id });
      const cur = String(o.admin_comments ?? '');
      const next = cur ? `${cur}
${op.note}` : op.note;
      if (next.length > 200) throw new CommerceError('VALIDATION_FAILED', `Base seller comments are limited to 200 characters; current ${cur.length} + note would be ${next.length}.`, { connectionId: this.id });
      return { value: cur, noteAfter: next, description: `order ${op.orderId} seller comment (admin_comments)`, warnings: ['The note is appended to the order seller comment; it is not visible to the buyer.'] };
    }
    if (op.kind === 'order_status') {
      const o = await this.getOrder(op.orderId, false, signal);
      const names = await this.orderStatuses(signal);
      const n = names.find((s) => s.id === o.platformStatus)?.name ?? o.platformStatus;
      return { value: o.platformStatus, description: `order ${op.orderId} status "${n}" (${o.platformStatus})` };
    }
    const inventory = await this.pickInventory(op, signal);
    const id = op.variantId ?? op.productId;
    const r = await this.call<J>('getInventoryProductsList', { inventory_id: intId(inventory, 'catalogId'), filter_id: intId(id, 'productId'), include_variants: true }, false, signal);
    const p = (Object.values(r.products ?? {}) as J[]).find((x) => String(x.id) === String(id));
    if (!p) throw new CommerceError('NOT_FOUND', `Product ${id} not found in Base catalog ${inventory}`, { connectionId: this.id });
    if (op.kind === 'stock') {
      const locs = Object.keys(p.stock ?? {});
      const loc = op.locationId ?? (locs.length === 1 ? locs[0] : undefined);
      if (!loc) throw new CommerceError('AMBIGUOUS_TARGET', `Product ${id} has stock in ${locs.length} warehouses (${locs.join(', ')}); specify locationId.`, { connectionId: this.id });
      if (!(loc in (p.stock ?? {}))) throw new CommerceError('NOT_FOUND', `Warehouse ${loc} not present for product ${id}`, { connectionId: this.id });
      return { value: String(p.stock[loc]), description: `product ${id} stock in ${loc} (catalog ${inventory})` };
    }
    const groups = Object.keys(p.prices ?? {});
    const g = op.priceGroup ?? (groups.length === 1 ? groups[0] : undefined);
    if (!g) throw new CommerceError('AMBIGUOUS_TARGET', `Product ${id} has ${groups.length} price groups (${groups.join(', ')}); specify priceGroup.`, { connectionId: this.id });
    if (!(g in (p.prices ?? {}))) throw new CommerceError('NOT_FOUND', `Price group ${g} not present for product ${id}`, { connectionId: this.id });
    return { value: normalizeMoney(p.prices[g]), description: `product ${id} gross price in group ${g} (catalog ${inventory})`, currency: null, warnings: ['Base does not return the price-group currency; verify it in Base before approving.'] };
  }

  async write(op: WriteOperation, _current: CurrentState, signal?: AbortSignal): Promise<WriteResult> {
    if (!this.writable) throw new CommerceError('MODE_FORBIDS', `Connection ${this.id} is configured read-only`, { connectionId: this.id });
    if (op.kind === 'offer_publication') throw new CommerceError('NOT_SUPPORTED', 'Offer publication is an Allegro concept.', { connectionId: this.id });
    if (op.kind === 'product_draft') {
      const t = await this.draftTarget(op, signal);
      const params: Record<string, unknown> = {
        inventory_id: intId(t.inventory, 'catalogId'), sku: op.sku, text_fields: { name: op.name },
        prices: { [t.priceGroup]: Number(formatDecimal(parseDecimal(op.regularPrice), 2)) },
      };
      if (op.stockQuantity !== undefined) params.stock = { [t.warehouse as string]: op.stockQuantity };
      const r = await this.call<J>('addInventoryProduct', params, true, signal);
      const warn = r.warnings && Object.keys(r.warnings).length ? ` warnings: ${JSON.stringify(r.warnings)}` : '';
      return { applied: true, detail: `product ${r.product_id} created in catalog ${t.inventory}${warn}` };
    }
    if (op.kind === 'order_note') {
      const cur = await this.readCurrent(op, signal);
      await this.call('setOrderFields', { order_id: intId(op.orderId, 'orderId'), admin_comments: cur.noteAfter }, true, signal);
      return { applied: true, detail: `note appended to order ${op.orderId}` };
    }
    if (op.kind === 'order_status') {
      await this.call('setOrderStatus', { order_id: intId(op.orderId, 'orderId'), status_id: intId(op.status, 'status') }, true, signal);
      return { applied: true, detail: `order ${op.orderId} -> status ${op.status}` };
    }
    const inventory = await this.pickInventory(op, signal);
    const id = op.variantId ?? op.productId;
    if (op.kind === 'stock') {
      const cur = await this.readCurrent(op, signal);
      const loc = /in ([a-z]+_\d+)/.exec(cur.description)?.[1] ?? op.locationId;
      const r = await this.call<J>('updateInventoryProductsStock', { inventory_id: intId(inventory, 'catalogId'), products: { [id]: { [loc as string]: op.quantity } } }, true, signal);
      if (r.warnings && Object.keys(r.warnings).length) throw new CommerceError('VALIDATION_FAILED', `Base warning: ${JSON.stringify(r.warnings)}`, { connectionId: this.id });
      return { applied: (r.counter ?? 0) > 0, detail: `${r.counter} product(s) updated` };
    }
    const cur = await this.readCurrent(op, signal);
    const group = /group (\S+)/.exec(cur.description)?.[1] ?? op.priceGroup;
    const r = await this.call<J>('updateInventoryProductsPrices', { inventory_id: intId(inventory, 'catalogId'), products: { [id]: { [group as string]: Number(formatDecimal(parseDecimal(op.amount), 2)) } } }, true, signal);
    if (r.warnings && Object.keys(r.warnings).length) throw new CommerceError('VALIDATION_FAILED', `Base warning: ${JSON.stringify(r.warnings)}`, { connectionId: this.id });
    return { applied: (r.counter ?? 0) > 0, detail: `${r.counter} product(s) updated` };
  }
}
