import type { CommerceOrder } from '../core/models.js';

/**
 * Marks orders that describe the same sale.
 *
 * confirmed  – the importing platform quotes the exact source order id (Base order imported from Allegro:
 *              external_order_id === Allegro checkout-form id). Excluded from totals.
 * potential  – ids/amounts line up but identity cannot be proven (e.g. Base shop order vs a WooCommerce order:
 *              we do not know which Base shop maps to which Woo store). Kept in totals, flagged.
 */
export function markDuplicates(orders: CommerceOrder[]): CommerceOrder[] {
  const out = orders.map((o) => ({ ...o }));
  const byKey = new Map<string, CommerceOrder>();
  for (const o of out) byKey.set(`${o.source.platform}:${o.source.externalId}`, o);

  for (const o of out) {
    if (o.source.platform !== 'baselinker' || !o.importedFrom) continue;
    const { system, externalOrderId } = o.importedFrom;
    if (system === 'allegro') {
      const original = out.find((x) => x.source.platform === 'allegro' && x.source.externalId === externalOrderId);
      if (original) {
        o.duplicate = { status: 'confirmed', ofConnectionId: original.source.connectionId, ofOrderId: original.source.externalId, reason: 'Base order imported from Allegro; external_order_id equals the Allegro checkout-form id' };
      }
      continue;
    }
    const shopId = o.source.extra?.shopOrderId ?? externalOrderId;
    const woo = out.find((x) => x.source.platform === 'woocommerce' && x.source.externalId === shopId && x.total.currency === o.total.currency && x.total.amount === o.total.amount);
    if (woo) {
      o.duplicate = { status: 'potential', ofConnectionId: woo.source.connectionId, ofOrderId: woo.source.externalId, reason: 'Base shop-sourced order has the same shop order id, currency and total as this WooCommerce order, but the Base shop is not mapped to a Woo connection, so identity is unconfirmed' };
    }
  }
  void byKey;
  return out;
}

export function countsInSales(o: CommerceOrder, includeUnpaid: boolean): { counted: boolean; reason?: string } {
  if (o.duplicate?.status === 'confirmed') return { counted: false, reason: 'confirmed duplicate' };
  switch (o.state) {
    case 'open':
    case 'fulfilled':
      return { counted: true };
    case 'unpaid':
      return includeUnpaid ? { counted: true } : { counted: false, reason: 'unpaid' };
    case 'cancelled':
      return { counted: false, reason: 'cancelled' };
    case 'refunded':
      return { counted: false, reason: 'refunded' };
    default:
      // Custom platform status we could not classify: counted, but reported as uncertain by the caller.
      return { counted: true };
  }
}
