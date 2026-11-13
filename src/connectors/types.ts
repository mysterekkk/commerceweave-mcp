import type { CommerceOrder, CommerceProduct, CommerceStore, Platform } from '../core/models.js';

export interface ListProductsQuery {
  query?: string;
  sku?: string;
  ean?: string;
  limit: number;
  page: number;
  /** Base catalog id, ignored by other platforms. */
  catalogId?: string;
  includeVariants?: boolean;
}
export interface ProductPage {
  products: CommerceProduct[];
  total: number | null;
  hasMore: boolean;
  warnings: string[];
}

export interface ListOrdersQuery {
  from: Date;
  to: Date;
  includePersonalData: boolean;
  maxOrders: number;
}
export interface OrderPage {
  orders: CommerceOrder[];
  /** true when maxOrders cut the result off. */
  truncated: boolean;
  warnings: string[];
}

export type WriteOperation =
  | { kind: 'stock'; productId: string; variantId?: string; catalogId?: string; locationId?: string; quantity: number }
  | { kind: 'price'; productId: string; variantId?: string; catalogId?: string; priceGroup?: string; amount: string; currency?: string | null }
  | { kind: 'order_status'; orderId: string; status: string }
  | { kind: 'order_note'; orderId: string; note: string }
  /** Allegro: start (ACTIVATE) or end (END) the publication of an offer. */
  | { kind: 'offer_publication'; offerId: string; action: 'ACTIVATE' | 'END' }
  /** WooCommerce: create a simple product in DRAFT status (never published). `sku` is mandatory so the result is identifiable. */
  | { kind: 'product_draft'; sku: string; name: string; regularPrice: string; stockQuantity?: number };

export interface CurrentState {
  /** Opaque, comparable snapshot of the field being changed. */
  value: string;
  description: string;
  currency?: string | null;
  /** Platform revision tokens needed for optimistic concurrency. */
  revision?: string;
  /** For order_note: the value `value` must have after the note is added (used for read-back verification). */
  noteAfter?: string;
  /** Human-readable ambiguity warnings (e.g. product on sale). */
  warnings?: string[];
}

export interface WriteResult {
  applied: boolean;
  detail: string;
}

/** A configured platform account. */
export interface Connector {
  readonly id: string;
  readonly platform: Platform;
  readonly demo: boolean;
  describe(): Promise<CommerceStore>;
  listProducts(q: ListProductsQuery, signal?: AbortSignal): Promise<ProductPage>;
  listOrders(q: ListOrdersQuery, signal?: AbortSignal): Promise<OrderPage>;
  getOrder(orderId: string, includePersonalData: boolean, signal?: AbortSignal): Promise<CommerceOrder>;
  /** Reads the exact current value that a write operation would replace. */
  readCurrent(op: WriteOperation, signal?: AbortSignal): Promise<CurrentState>;
  /** Executes one write. Must never retry automatically. */
  write(op: WriteOperation, current: CurrentState, signal?: AbortSignal): Promise<WriteResult>;
  /** Valid platform order statuses, when the platform exposes a fixed list. */
  orderStatuses?(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>>;
  /** Whether this connection is allowed to write at all (e.g. Woo read-only key mode). */
  readonly writable: boolean;
}
