import { assertSafeWooUrl, type WooConfig } from '../../core/config.js';
import { CommerceError } from '../../core/errors.js';
import { createPinnedAgent } from '../../core/host-guard.js';
import { HttpClient } from '../../core/http.js';
import { formatDecimal, normalizeMoney, parseDecimal } from '../../core/money.js';
import type { CommerceOrder, CommercePrice, CommerceProduct, CommerceStore, CommerceVariant, CommerceInventory, OrderState } from '../../core/models.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { maskEmail, maskName, maskPhone } from '../../core/redact.js';
import type { Connector, CurrentState, ListOrdersQuery, ListProductsQuery, OrderPage, ProductPage, WriteOperation, WriteResult } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export const WOO_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;

const STATE: Record<string, OrderState> = {
  pending: 'unpaid', 'on-hold': 'unpaid', 'checkout-draft': 'unpaid', processing: 'open',
  completed: 'fulfilled', cancelled: 'cancelled', failed: 'cancelled', trash: 'cancelled', refunded: 'refunded',
};

export class WooConnector implements Connector {
  readonly platform = 'woocommerce' as const;
  readonly demo = false;
  readonly id: string;
  private readonly http: HttpClient;
  private currency?: string;

  constructor(private readonly cfg: WooConfig, public readonly writable: boolean, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
    this.id = cfg.id;
    if (!cfg.allowInsecure) assertSafeWooUrl(cfg.storeUrl);
    const base = cfg.storeUrl.replace(/\/+$/, '') + '/wp-json/wc/v3/';
    const auth = 'Basic ' + Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
    this.http = new HttpClient({
      connectionId: cfg.id, baseUrl: base, limiter: new RateLimiter(8, 1000), sleep: opts.sleep,
      // The connection itself is DNS-pinned: the validated address is the one connected to (no rebinding window).
      dispatcher: cfg.allowInsecure ? undefined : createPinnedAgent(),
      defaultHeaders: () => ({ Authorization: auth, Accept: 'application/json' }),
    });
  }

  async describe(): Promise<CommerceStore> {
    return { connectionId: this.id, platform: this.platform, environment: new URL(this.cfg.storeUrl).protocol === 'https:' ? 'https' : 'insecure-dev', storeLabel: new URL(this.cfg.storeUrl).host };
  }

  private async getCurrency(signal?: AbortSignal): Promise<string | null> {
    if (this.cfg.currency) return this.cfg.currency;
    if (this.currency) return this.currency;
    try {
      const r = await this.http.request<J>({ path: 'data/currencies/current', signal });
      if (typeof r.data?.code === 'string') return (this.currency = r.data.code);
    } catch { /* falls through: currency unknown */ }
    return null;
  }

  private inventory(p: J): CommerceInventory {
    const managed = p.manage_stock === true;
    const status = p.stock_status === 'instock' ? 'in_stock' : p.stock_status === 'outofstock' ? 'out_of_stock' : p.stock_status === 'onbackorder' ? 'backorder' : 'unknown';
    return { total: managed && typeof p.stock_quantity === 'number' ? p.stock_quantity : null, managed, status };
  }

  private prices(p: J, currency: string | null): CommercePrice[] {
    const out: CommercePrice[] = [];
    const reg = p.regular_price ?? p.price;
    if (reg !== undefined && reg !== '' && reg !== null) out.push({ amount: normalizeMoney(reg), currency, group: 'regular', onSale: false });
    if (p.sale_price) out.push({ amount: normalizeMoney(p.sale_price), currency, group: 'sale', onSale: true });
    return out;
  }

  private toVariant(v: J, parent: J, currency: string | null): CommerceVariant {
    const inv = v.manage_stock === 'parent' ? { ...this.inventory(parent), managed: false, total: null } : this.inventory(v);
    return {
      source: { connectionId: this.id, platform: this.platform, externalId: String(v.id), extra: { parentId: String(parent.id) } },
      sku: v.sku || null, ean: null, name: (v.attributes ?? []).map((a: J) => a.option).join(' / ') || null,
      attributes: Object.fromEntries((v.attributes ?? []).map((a: J) => [String(a.name), String(a.option)])),
      prices: this.prices(v, currency), inventory: inv,
    };
  }

  private async toProduct(p: J, currency: string | null, withVariants: boolean, signal?: AbortSignal): Promise<CommerceProduct> {
    const variable = p.type === 'variable';
    const prod: CommerceProduct = {
      source: { connectionId: this.id, platform: this.platform, externalId: String(p.id) },
      sku: p.sku || null, ean: null, name: String(p.name ?? ''), kind: variable ? 'variable' : 'simple', status: p.status ?? null,
      prices: this.prices(p, currency), inventory: this.inventory(p),
      untrustedText: p.short_description ? { description: String(p.short_description).slice(0, 500) } : undefined,
    };
    if (variable && withVariants) {
      const r = await this.http.request<J[]>({ path: `products/${p.id}/variations`, query: { per_page: 100 }, signal });
      prod.variants = r.data.map((v) => this.toVariant(v, p, currency));
    }
    return prod;
  }

  async listProducts(q: ListProductsQuery, signal?: AbortSignal): Promise<ProductPage> {
    const per = Math.min(q.limit, 100);
    const r = await this.http.request<J[]>({ path: 'products', query: { per_page: per, page: q.page, search: q.query, sku: q.sku, status: 'any' }, signal });
    const currency = await this.getCurrency(signal);
    const products: CommerceProduct[] = [];
    for (const p of r.data) products.push(await this.toProduct(p, currency, q.includeVariants ?? false, signal));
    const totalPages = Number(r.headers.get('x-wp-totalpages') ?? 1);
    const total = r.headers.get('x-wp-total');
    const warnings: string[] = [];
    if (!currency) warnings.push('Store currency could not be determined; prices have no currency.');
    return { products, total: total ? Number(total) : null, hasMore: q.page < totalPages, warnings };
  }

  async listOrders(q: ListOrdersQuery, signal?: AbortSignal): Promise<OrderPage> {
    const orders: CommerceOrder[] = [];
    let page = 1;
    let truncated = false;
    for (;;) {
      const r = await this.http.request<J[]>({ path: 'orders', query: { after: q.from.toISOString(), before: q.to.toISOString(), per_page: 100, page, orderby: 'date', order: 'asc' }, signal });
      for (const o of r.data) orders.push(this.toOrder(o, q.includePersonalData));
      const totalPages = Number(r.headers.get('x-wp-totalpages') ?? 1);
      if (orders.length >= q.maxOrders) { truncated = page < totalPages || orders.length > q.maxOrders; orders.length = Math.min(orders.length, q.maxOrders); break; }
      if (page >= totalPages) break;
      page++;
    }
    return { orders, truncated, warnings: truncated ? [`Result truncated at ${q.maxOrders} orders.`] : [] };
  }

  async getOrder(orderId: string, includePersonalData: boolean, signal?: AbortSignal): Promise<CommerceOrder> {
    const r = await this.http.request<J>({ path: `orders/${encodeURIComponent(orderId)}`, signal });
    return this.toOrder(r.data, includePersonalData);
  }

  private toOrder(o: J, pii: boolean): CommerceOrder {
    const b = o.billing ?? {};
    const name = `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim();
    const state = STATE[o.status];
    return {
      source: { connectionId: this.id, platform: this.platform, externalId: String(o.id) },
      createdAt: o.date_created_gmt ? `${o.date_created_gmt}Z` : new Date(o.date_created).toISOString(),
      platformStatus: String(o.status), state: state ?? 'unknown', stateClassified: state !== undefined,
      total: { amount: normalizeMoney(o.total ?? '0'), currency: String(o.currency ?? '') },
      items: (o.line_items ?? []).map((i: J) => ({
        name: String(i.name), sku: i.sku || null, externalProductId: i.product_id ? String(i.product_id) : null,
        externalVariantId: i.variation_id ? String(i.variation_id) : null, quantity: Number(i.quantity),
        unitPrice: i.price !== undefined ? { amount: normalizeMoney(i.price), currency: String(o.currency ?? '') } : null,
      })),
      customer: pii
        ? { name: name || undefined, email: b.email || undefined, phone: b.phone || undefined, redacted: false }
        : { name: maskName(name), email: maskEmail(b.email), phone: maskPhone(b.phone), redacted: true },
      untrustedText: o.customer_note ? { buyerNote: pii ? String(o.customer_note).slice(0, 500) : '[redacted — request includePersonalData]' } : undefined,
    };
  }

  async getProduct(id: string, signal?: AbortSignal): Promise<CommerceProduct> {
    const r = await this.http.request<J>({ path: `products/${encodeURIComponent(id)}`, signal });
    return this.toProduct(r.data, await this.getCurrency(signal), true, signal);
  }

  async getVariations(id: string, signal?: AbortSignal): Promise<CommerceVariant[]> {
    const parent = await this.http.request<J>({ path: `products/${encodeURIComponent(id)}`, signal });
    const currency = await this.getCurrency(signal);
    const r = await this.http.request<J[]>({ path: `products/${encodeURIComponent(id)}/variations`, query: { per_page: 100 }, signal });
    return r.data.map((v) => this.toVariant(v, parent.data, currency));
  }

  async getCategories(signal?: AbortSignal) {
    const r = await this.http.request<J[]>({ path: 'products/categories', query: { per_page: 100 }, signal });
    return r.data.map((c) => ({ id: String(c.id), name: String(c.name), parent: c.parent ? String(c.parent) : null, count: Number(c.count ?? 0) }));
  }

  /** WooCommerce's own sales report. Order totals here are Woo's definition (net of refunds, excludes some statuses). */
  async getSalesReport(dateMin: string, dateMax: string, signal?: AbortSignal) {
    const r = await this.http.request<J[]>({ path: 'reports/sales', query: { date_min: dateMin, date_max: dateMax }, signal });
    const x = r.data[0] ?? {};
    return { dateMin, dateMax, currency: await this.getCurrency(signal), totalSales: x.total_sales, netSales: x.net_sales, averageSales: x.average_sales, totalOrders: x.total_orders, totalItems: x.total_items, totalTax: x.total_tax, totalShipping: x.total_shipping, totalRefunds: x.total_refunds, totalDiscount: x.total_discount };
  }

  async orderStatuses() {
    return WOO_STATUSES.map((s) => ({ id: s, name: s }));
  }

  private target(op: Extract<WriteOperation, { kind: 'stock' | 'price' }>) {
    return op.variantId ? { path: `products/${encodeURIComponent(op.productId)}/variations/${encodeURIComponent(op.variantId)}`, variation: true } : { path: `products/${encodeURIComponent(op.productId)}`, variation: false };
  }

  async readCurrent(op: WriteOperation, signal?: AbortSignal): Promise<CurrentState> {
    if (op.kind === 'order_note') {
      const r = await this.http.request<J[]>({ path: `orders/${encodeURIComponent(op.orderId)}/notes`, signal });
      return { value: String(r.data.length), noteAfter: String(r.data.length + 1), description: `order ${op.orderId} private notes (count)`, warnings: ['The note is added as a PRIVATE (staff-only) note, never sent to the customer.'] };
    }
    if (op.kind === 'order_status') {
      const r = await this.http.request<J>({ path: `orders/${encodeURIComponent(op.orderId)}`, signal });
      return { value: String(r.data.status), description: `order #${r.data.id} status "${r.data.status}"` };
    }
    const t = this.target(op);
    const r = await this.http.request<J>({ path: t.path, signal });
    const p = r.data;
    if (!t.variation && p.type === 'variable') {
      throw new CommerceError('AMBIGUOUS_TARGET', `Product ${p.id} is variable; specify variantId (its variations hold their own ${op.kind === 'stock' ? 'stock' : 'prices'}).`, { connectionId: this.id });
    }
    const warnings: string[] = [];
    if (op.kind === 'stock') {
      if (p.manage_stock !== true) warnings.push('Stock management is currently off for this item; the update will turn it on.');
      return { value: p.manage_stock === true ? String(p.stock_quantity) : 'unmanaged', description: `${t.variation ? 'variation' : 'product'} ${p.id} stock`, warnings };
    }
    if (p.sale_price) warnings.push(`Item has an active sale price (${p.sale_price}); only the regular price is changed.`);
    return { value: String(p.regular_price ?? ''), description: `${t.variation ? 'variation' : 'product'} ${p.id} regular price`, currency: await this.getCurrency(signal), warnings };
  }

  async write(op: WriteOperation, _current: CurrentState, signal?: AbortSignal): Promise<WriteResult> {
    if (!this.writable) throw new CommerceError('MODE_FORBIDS', `Connection ${this.id} is configured read-only`, { connectionId: this.id });
    if (op.kind === 'order_note') {
      await this.http.request({ method: 'POST', path: `orders/${encodeURIComponent(op.orderId)}/notes`, body: JSON.stringify({ note: op.note, customer_note: false }), contentType: 'application/json', signal });
      return { applied: true, detail: `private note added to order ${op.orderId}` };
    }
    if (op.kind === 'order_status') {
      if (!(WOO_STATUSES as readonly string[]).includes(op.status)) throw new CommerceError('VALIDATION_FAILED', `Unknown WooCommerce status "${op.status}". Allowed: ${WOO_STATUSES.join(', ')}`);
      await this.http.request({ method: 'PUT', path: `orders/${encodeURIComponent(op.orderId)}`, body: JSON.stringify({ status: op.status }), contentType: 'application/json', signal });
      return { applied: true, detail: `order ${op.orderId} -> ${op.status}` };
    }
    const t = this.target(op);
    const body = op.kind === 'stock' ? { manage_stock: true, stock_quantity: op.quantity } : { regular_price: formatDecimal(parseDecimal(op.amount), 2) };
    await this.http.request({ method: 'PUT', path: t.path, body: JSON.stringify(body), contentType: 'application/json', signal });
    return { applied: true, detail: `${t.path} updated` };
  }
}
