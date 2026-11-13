import { randomUUID } from 'node:crypto';
import type { AllegroConfig } from '../../core/config.js';
import { CommerceError } from '../../core/errors.js';
import { HttpClient, type RequestOptions } from '../../core/http.js';
import { normalizeMoney } from '../../core/money.js';
import type { CommerceOrder, CommerceProduct, CommerceStore, OrderState } from '../../core/models.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { maskEmail, maskName, maskPhone } from '../../core/redact.js';
import type { TokenStore } from '../../core/token-store.js';
import type { Connector, CurrentState, ListOrdersQuery, ListProductsQuery, OrderPage, ProductPage, WriteOperation, WriteResult } from '../types.js';
import { AllegroAuth, allegroHosts } from './auth.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;
const CT = 'application/vnd.allegro.public.v1+json';
export const ALLEGRO_FULFILLMENT_STATUSES = ['NEW', 'PROCESSING', 'READY_FOR_SHIPMENT', 'READY_FOR_PICKUP', 'SENT', 'PICKED_UP', 'CANCELLED', 'SUSPENDED'] as const;

export class AllegroConnector implements Connector {
  readonly platform = 'allegro' as const;
  readonly demo = false;
  readonly id: string;
  readonly auth: AllegroAuth;
  private readonly http: HttpClient;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(
    private readonly cfg: AllegroConfig,
    public readonly writable: boolean,
    store: TokenStore,
    opts: { sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number; pollTimeoutMs?: number } = {},
  ) {
    this.id = cfg.id;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 45_000;
    this.auth = new AllegroAuth(cfg, store, opts.sleep);
    this.http = new HttpClient({ connectionId: cfg.id, baseUrl: allegroHosts(cfg).api, limiter: new RateLimiter(9, 1000), sleep: opts.sleep });
  }

  private async api<T = J>(r: RequestOptions, signal?: AbortSignal): Promise<T> {
    const isRead = (r.method ?? 'GET') === 'GET';
    const go = async (force: boolean) => {
      const token = await this.auth.getAccessToken(force);
      return this.http.request<T>({ ...r, signal, headers: { Authorization: `Bearer ${token}`, Accept: CT, ...(r.body ? { 'Content-Type': CT } : {}), ...(r.headers ?? {}) } });
    };
    try {
      return (await go(false)).data;
    } catch (e) {
      // One transparent token refresh for reads; writes are never repeated automatically.
      if (isRead && e instanceof CommerceError && e.code === 'AUTH_FAILED') return (await go(true)).data;
      throw e;
    }
  }

  async describe(): Promise<CommerceStore> {
    const me = await this.api<J>({ path: 'me' });
    return { connectionId: this.id, platform: this.platform, environment: this.cfg.environment, storeLabel: String(me.login ?? 'allegro') };
  }

  async accountInfo(signal?: AbortSignal) {
    const me = await this.api<J>({ path: 'me' }, signal);
    return { id: String(me.id), login: String(me.login), environment: this.cfg.environment, company: me.company ? { name: me.company.name } : undefined, baseMarketplace: me.baseMarketplace?.id };
  }

  private toProduct(o: J): CommerceProduct {
    const available = typeof o.stock?.available === 'number' ? o.stock.available : null;
    const price = o.sellingMode?.price;
    return {
      source: { connectionId: this.id, platform: this.platform, externalId: String(o.id) },
      sku: o.external?.id ?? null, ean: null, name: String(o.name ?? ''), kind: 'offer', status: o.publication?.status ?? null,
      prices: price ? [{ amount: normalizeMoney(price.amount), currency: String(price.currency) }] : [],
      inventory: { total: available, managed: available !== null, status: available === null ? 'unknown' : available > 0 ? 'in_stock' : 'out_of_stock' },
    };
  }

  async listProducts(q: ListProductsQuery, signal?: AbortSignal): Promise<ProductPage> {
    const limit = Math.min(q.limit, 100);
    const d = await this.api<J>({ path: 'sale/offers', query: { limit, offset: (q.page - 1) * limit, name: q.query, 'external.id': q.sku }, }, signal);
    const products = (d.offers ?? []).map((o: J) => this.toProduct(o));
    const total = typeof d.totalCount === 'number' ? d.totalCount : null;
    return { products, total, hasMore: total !== null ? q.page * limit < total : products.length === limit, warnings: q.ean ? ['Allegro offer listing cannot filter by EAN; ean filter was ignored.'] : [] };
  }

  async searchOffers(args: { name?: string; status?: string; priceFrom?: string; priceTo?: string; offerId?: string; limit: number; offset: number }, signal?: AbortSignal) {
    const d = await this.api<J>({ path: 'sale/offers', query: {
      limit: Math.min(args.limit, 100), offset: args.offset, name: args.name, 'publication.status': args.status,
      'sellingMode.price.amount.gte': args.priceFrom, 'sellingMode.price.amount.lte': args.priceTo, 'offer.id': args.offerId,
    } }, signal);
    return { offers: (d.offers ?? []).map((o: J) => this.toProduct(o)), totalCount: d.totalCount as number | undefined };
  }

  async getOffer(offerId: string, signal?: AbortSignal) {
    const o = await this.api<J>({ path: `sale/product-offers/${encodeURIComponent(offerId)}` }, signal);
    return {
      id: String(o.id), name: String(o.name ?? ''), status: o.publication?.status as string | undefined,
      stock: o.stock ? { available: o.stock.available as number, unit: o.stock.unit as string | undefined } : undefined,
      price: o.sellingMode?.price ? { amount: normalizeMoney(o.sellingMode.price.amount), currency: String(o.sellingMode.price.currency) } : undefined,
      format: o.sellingMode?.format as string | undefined, external: o.external?.id as string | undefined, category: o.category?.id as string | undefined,
    };
  }

  private classify(o: J): { state: OrderState; classified: boolean } {
    const f = o.fulfillment?.status;
    if (o.status === 'CANCELLED' || f === 'CANCELLED') return { state: 'cancelled', classified: true };
    if (f === 'RETURNED') return { state: 'refunded', classified: true };
    if (f === 'SENT' || f === 'PICKED_UP') return { state: 'fulfilled', classified: true };
    if (o.status === 'READY_FOR_PROCESSING') return { state: 'open', classified: true };
    if (o.status === 'BOUGHT' || o.status === 'FILLED_IN') return { state: 'unpaid', classified: true };
    return { state: 'unknown', classified: false };
  }

  private toOrder(o: J, pii: boolean): CommerceOrder {
    const b = o.buyer ?? {};
    const name = `${b.firstName ?? ''} ${b.lastName ?? ''}`.trim();
    const { state, classified } = this.classify(o);
    const items = (o.lineItems ?? []).map((i: J) => ({
      name: String(i.offer?.name ?? ''), sku: i.offer?.external?.id ?? null, externalProductId: i.offer?.id ? String(i.offer.id) : null,
      externalVariantId: null, quantity: Number(i.quantity),
      unitPrice: i.price ? { amount: normalizeMoney(i.price.amount), currency: String(i.price.currency) } : null,
    }));
    const total = o.summary?.totalToPay;
    return {
      source: { connectionId: this.id, platform: this.platform, externalId: String(o.id), extra: o.revision ? { revision: String(o.revision) } : undefined },
      createdAt: String(o.lineItems?.[0]?.boughtAt ?? o.updatedAt ?? new Date(0).toISOString()),
      platformStatus: `${o.status}/${o.fulfillment?.status ?? 'n/a'}`, state, stateClassified: classified,
      total: { amount: normalizeMoney(total?.amount ?? '0'), currency: String(total?.currency ?? '') }, items,
      customer: pii
        ? { name: name || undefined, email: b.email || undefined, phone: b.phoneNumber || undefined, login: b.login || undefined, redacted: false }
        : { name: maskName(name), email: maskEmail(b.email), phone: maskPhone(b.phoneNumber), login: b.login ? `${String(b.login).slice(0, 1)}***` : undefined, redacted: true },
      untrustedText: o.messageToSeller ? { buyerNote: pii ? String(o.messageToSeller).slice(0, 500) : '[redacted — request includePersonalData]' } : undefined,
    };
  }

  async listOrders(q: ListOrdersQuery, signal?: AbortSignal): Promise<OrderPage> {
    const orders: CommerceOrder[] = [];
    let offset = 0;
    let truncated = false;
    for (;;) {
      const d = await this.api<J>({ path: 'order/checkout-forms', query: {
        limit: 100, offset, sort: 'lineItems.boughtAt', 'lineItems.boughtAt.gte': q.from.toISOString(), 'lineItems.boughtAt.lte': q.to.toISOString(),
      } }, signal);
      const rows: J[] = d.checkoutForms ?? [];
      for (const o of rows) orders.push(this.toOrder(o, q.includePersonalData));
      offset += rows.length;
      if (orders.length >= q.maxOrders) { truncated = offset < (d.totalCount ?? 0) || orders.length > q.maxOrders; orders.length = Math.min(orders.length, q.maxOrders); break; }
      if (rows.length < 100 || offset >= (d.totalCount ?? 0)) break;
    }
    return { orders, truncated, warnings: truncated ? [`Result truncated at ${q.maxOrders} orders.`] : [] };
  }

  async getOrder(orderId: string, pii: boolean, signal?: AbortSignal): Promise<CommerceOrder> {
    return this.toOrder(await this.api<J>({ path: `order/checkout-forms/${encodeURIComponent(orderId)}` }, signal), pii);
  }

  async getOrderEvents(args: { from?: string; limit: number; types?: string[] }, signal?: AbortSignal) {
    const d = await this.api<J>({ path: 'order/events', query: { from: args.from, limit: Math.min(args.limit, 1000), type: args.types } }, signal);
    return (d.events ?? []).map((e: J) => ({ eventId: String(e.id), type: String(e.type), occurredAt: String(e.occurredAt), orderId: String(e.order?.checkoutForm?.id ?? '') }));
  }

  async orderStatuses() {
    return ALLEGRO_FULFILLMENT_STATUSES.map((s) => ({ id: s, name: s }));
  }

  async readCurrent(op: WriteOperation, signal?: AbortSignal): Promise<CurrentState> {
    if (op.kind === 'order_note') throw new CommerceError('NOT_SUPPORTED', 'Allegro has no seller order-note endpoint in this connector.', { connectionId: this.id });
    if (op.kind === 'order_status') {
      const o = await this.api<J>({ path: `order/checkout-forms/${encodeURIComponent(op.orderId)}` }, signal);
      const w: string[] = [];
      if (o.status !== 'READY_FOR_PROCESSING') w.push(`Order payment state is ${o.status}; fulfillment changes on unpaid orders are usually a mistake.`);
      return { value: String(o.fulfillment?.status ?? 'NEW'), description: `order ${op.orderId} fulfillment status`, revision: o.revision ? String(o.revision) : undefined, warnings: w };
    }
    const offer = await this.getOffer(op.productId, signal);
    if (op.kind === 'stock') {
      if (!offer.stock) throw new CommerceError('NOT_SUPPORTED', `Offer ${op.productId} has no stock section (not a buy-now offer?)`, { connectionId: this.id });
      return { value: String(offer.stock.available), description: `offer ${op.productId} available stock` };
    }
    if (!offer.price) throw new CommerceError('NOT_SUPPORTED', `Offer ${op.productId} has no buy-now price`, { connectionId: this.id });
    const w = offer.format && offer.format !== 'BUY_NOW' ? [`Offer format is ${offer.format}; only the buy-now price is changed.`] : [];
    return { value: offer.price.amount, description: `offer ${op.productId} buy-now price`, currency: offer.price.currency, warnings: w };
  }

  /** Request -> command id -> status -> per-offer result. A 201 only means "registered", never "done". */
  private async runCommand(kind: 'quantity' | 'price', body: object, offerId: string, signal?: AbortSignal): Promise<string> {
    const commandId = randomUUID();
    const base = `sale/offer-${kind}-change-commands/${commandId}`;
    await this.api({ method: 'PUT', path: base, body: JSON.stringify(body), idempotent: false }, signal);
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const s = await this.api<J>({ path: base }, signal);
      if (s.completedAt) {
        const t = await this.api<J>({ path: `${base}/tasks` }, signal);
        const task = (t.tasks ?? []).find((x: J) => String(x.offer?.id) === offerId) ?? (t.tasks ?? [])[0];
        if (!task || String(task.status).toUpperCase() !== 'SUCCESS') {
          const msg = (task?.errors ?? []).map((e: J) => e.userMessage ?? e.message).join('; ') || task?.message || 'unknown reason';
          throw new CommerceError('VALIDATION_FAILED', `Allegro command ${commandId} failed for offer ${offerId}: ${msg}`, { connectionId: this.id });
        }
        return commandId;
      }
      if (Date.now() > deadline) {
        throw new CommerceError('WRITE_OUTCOME_UNKNOWN', `Allegro command ${commandId} was accepted but has not completed after ${Math.round(this.pollTimeoutMs / 1000)}s. Check GET /sale/offer-${kind}-change-commands/${commandId} before retrying.`, { connectionId: this.id });
      }
    }
  }

  async write(op: WriteOperation, current: CurrentState, signal?: AbortSignal): Promise<WriteResult> {
    if (!this.writable) throw new CommerceError('MODE_FORBIDS', `Connection ${this.id} is configured read-only`, { connectionId: this.id });
    if (op.kind === 'order_note') throw new CommerceError('NOT_SUPPORTED', 'Allegro has no seller order-note endpoint in this connector.', { connectionId: this.id });
    if (op.kind === 'order_status') {
      if (!(ALLEGRO_FULFILLMENT_STATUSES as readonly string[]).includes(op.status)) throw new CommerceError('VALIDATION_FAILED', `Unknown Allegro fulfillment status "${op.status}". Allowed: ${ALLEGRO_FULFILLMENT_STATUSES.join(', ')}`);
      await this.api({ method: 'PUT', path: `order/checkout-forms/${encodeURIComponent(op.orderId)}/fulfillment`, query: { 'checkoutForm.revision': current.revision }, body: JSON.stringify({ status: op.status }), idempotent: false }, signal);
      return { applied: true, detail: `order ${op.orderId} fulfillment -> ${op.status}` };
    }
    const criteria = [{ offers: [{ id: op.productId }], type: 'CONTAINS_OFFERS' }];
    if (op.kind === 'stock') {
      const id = await this.runCommand('quantity', { modification: { changeType: 'FIXED', value: op.quantity }, offerCriteria: criteria }, op.productId, signal);
      return { applied: true, detail: `command ${id} succeeded` };
    }
    const cur = current.currency;
    if (op.currency && cur && op.currency !== cur) throw new CommerceError('VALIDATION_FAILED', `Currency mismatch: offer is in ${cur}, update is in ${op.currency}`, { connectionId: this.id });
    const id = await this.runCommand('price', { modification: { type: 'FIXED_PRICE', price: { amount: op.amount, currency: cur ?? op.currency } }, offerCriteria: criteria }, op.productId, signal);
    return { applied: true, detail: `command ${id} succeeded` };
  }
}
