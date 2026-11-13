import type { Registry } from '../connectors/registry.js';
import { fetchAllProducts, leaves, perConnection, type Leaf } from './reads.js';

export interface SkuMapGroup { label?: string; members: Array<{ connectionId: string; productId: string; variantId?: string }> }

interface Member { connectionId: string; productId: string; variantId?: string; quantity: number | null; sku: string | null; name: string; catalogId?: string }

const keyOf = (m: { connectionId: string; productId: string; variantId?: string }) => `${m.connectionId}|${m.productId}|${m.variantId ?? ''}`;
const toMember = (l: Leaf): Member => ({ connectionId: l.connectionId, productId: l.productId, variantId: l.variantId, quantity: l.total, sku: l.sku, name: l.name, catalogId: l.catalogId });

/**
 * Compares stock for the same product across connections. Pairing rules, in order:
 *  1. explicit skuMap groups from the config file (authoritative),
 *  2. identical SKU, but only if that SKU is unique inside every connection involved,
 *  3. identical EAN under the same uniqueness rule.
 * Anything else is reported as ambiguous or unmatched, never guessed.
 */
export async function findStockDiscrepancies(
  reg: Registry,
  a: { connectionIds?: string[]; skuMap: SkuMapGroup[]; sourceOfTruth?: string; maxItemsPerConnection: number },
  signal?: AbortSignal,
) {
  const conns = reg.select(a.connectionIds);
  const { results, errors } = await perConnection(conns, (c) => fetchAllProducts(c, a.maxItemsPerConnection, signal));
  const all: Leaf[] = [];
  const incomplete: string[] = [];
  for (const r of results) {
    if (!r.value.complete) incomplete.push(r.connection.id);
    for (const p of r.value.products) all.push(...leaves(p));
  }
  const used = new Set<string>();
  const groups: Array<{ basis: 'skuMap' | 'sku' | 'ean'; key: string; members: Member[] }> = [];
  const byKey = new Map(all.map((l) => [keyOf(l), l]));

  for (const g of a.skuMap) {
    const ms = g.members.map((m) => byKey.get(keyOf(m))).filter((x): x is Leaf => !!x);
    if (ms.length >= 2) {
      groups.push({ basis: 'skuMap', key: g.label ?? ms[0]?.sku ?? 'mapped', members: ms.map(toMember) });
      ms.forEach((m) => used.add(keyOf(m)));
    }
  }

  const ambiguous: Array<{ basis: string; value: string; connectionId: string; count: number }> = [];
  for (const basis of ['sku', 'ean'] as const) {
    const idx = new Map<string, Leaf[]>();
    for (const l of all) {
      const v = l[basis];
      if (!v || used.has(keyOf(l))) continue;
      const arr = idx.get(v) ?? [];
      arr.push(l);
      idx.set(v, arr);
    }
    for (const [value, ls] of idx) {
      const perConn = new Map<string, Leaf[]>();
      for (const l of ls) perConn.set(l.connectionId, [...(perConn.get(l.connectionId) ?? []), l]);
      if (perConn.size < 2) continue;
      let dup = false;
      for (const [connectionId, arr] of perConn) {
        if (arr.length > 1) { dup = true; ambiguous.push({ basis, value, connectionId, count: arr.length }); }
      }
      if (dup) continue;
      groups.push({ basis, key: value, members: ls.map(toMember) });
      ls.forEach((l) => used.add(keyOf(l)));
    }
  }

  const discrepancies: Array<{ basis: string; key: string; members: Member[]; min: number; max: number; difference: number }> = [];
  let inSync = 0;
  let notComparable = 0;
  for (const g of groups) {
    const qs = g.members.map((m) => m.quantity);
    if (qs.some((q) => q === null)) { notComparable++; continue; }
    const nums = qs as number[];
    const min = Math.min(...nums), max = Math.max(...nums);
    if (min === max) inSync++;
    else discrepancies.push({ ...g, min, max, difference: max - min });
  }

  const suggestedUpdates: Array<{ connectionId: string; productId: string; variantId?: string; catalogId?: string; currentQuantity: number | null; suggestedQuantity: number; reason: string }> = [];
  if (a.sourceOfTruth) {
    for (const d of discrepancies) {
      const src = d.members.find((m) => m.connectionId === a.sourceOfTruth);
      if (!src || src.quantity === null) continue;
      for (const m of d.members) {
        if (m.connectionId !== a.sourceOfTruth && m.quantity !== src.quantity) {
          suggestedUpdates.push({ connectionId: m.connectionId, productId: m.productId, variantId: m.variantId, catalogId: m.catalogId, currentQuantity: m.quantity, suggestedQuantity: src.quantity as number, reason: `match ${a.sourceOfTruth} (${d.basis} ${d.key})` });
        }
      }
    }
  }

  const unmatched = all.filter((l) => !used.has(keyOf(l)));
  return {
    comparedConnections: conns.map((c) => c.id),
    matchedGroups: groups.length, inSync, discrepancyCount: discrepancies.length, discrepancies,
    notComparable: { groups: notComparable, note: 'At least one side does not manage a stock quantity.' },
    ambiguous, unmatchedItems: { count: unmatched.length, sample: unmatched.slice(0, 20).map((l) => ({ connectionId: l.connectionId, productId: l.productId, variantId: l.variantId, sku: l.sku })) },
    suggestedUpdates: a.sourceOfTruth ? { sourceOfTruth: a.sourceOfTruth, updates: suggestedUpdates, note: 'Suggestions only. Nothing was changed. Use commerce_prepare_stock_update to create a reviewable proposal.' } : undefined,
    errors, complete: errors.length === 0 && incomplete.length === 0, incompleteConnections: incomplete,
    notes: ['Base quantities are summed across warehouses; a difference may reflect reservations or warehouses that are not published to the other platform.'],
  };
}
