import { ApprovalStore, type PlannedChange, type Proposal } from '../core/approvals.js';
import type { Registry } from '../connectors/registry.js';
import type { Connector, CurrentState, WriteOperation } from '../connectors/types.js';
import type { Mode } from '../core/config.js';
import { CommerceError, toCommerceError } from '../core/errors.js';
import { applyPercent, formatDecimal, normalizeMoney, parseDecimal, roundDecimal } from '../core/money.js';
import { log } from '../core/logging.js';

export const MAX_OPS_PER_PROPOSAL = 25;

/** Numeric-aware comparison so "39.9" equals "39.90"; falls back to exact string equality. */
export function sameValue(a: string, b: string): boolean {
  try {
    return parseDecimal(a) === parseDecimal(b);
  } catch {
    return a === b;
  }
}

export interface StockItem { productId: string; variantId?: string; catalogId?: string; locationId?: string; quantity: number }
export interface PriceItem { productId: string; variantId?: string; catalogId?: string; priceGroup?: string; newPrice?: string; changePercent?: string }

export class Writes {
  constructor(private readonly reg: Registry, private readonly store: ApprovalStore, private readonly mode: Mode) {}

  private guard(c: Connector, count: number) {
    if (this.mode === 'read_only') throw new CommerceError('MODE_FORBIDS', 'Server is in read_only mode; proposals are disabled.');
    if (!c.writable) throw new CommerceError('MODE_FORBIDS', `Connection ${c.id} is configured read-only.`, { connectionId: c.id });
    if (count < 1 || count > MAX_OPS_PER_PROPOSAL) throw new CommerceError('VALIDATION_FAILED', `A proposal must contain 1..${MAX_OPS_PER_PROPOSAL} changes.`);
  }

  private finish(c: Connector, title: string, changes: PlannedChange[], warnings: string[]) {
    const p = this.store.create({ connectionId: c.id, platform: c.platform, title, changes, warnings });
    return this.describe(p);
  }

  describe(p: Proposal) {
    const live = this.mode === 'approval_required';
    return {
      proposalId: p.id, status: p.status, connectionId: p.connectionId, platform: p.platform, title: p.title,
      createdAt: p.createdAt, expiresAt: p.expiresAt,
      changes: p.changes.map((c) => ({ target: c.label, before: c.beforeDisplay, after: c.afterDisplay })),
      warnings: p.warnings, result: p.result,
      nextStep: p.status !== 'pending' ? undefined : live
        ? `NOTHING HAS BEEN CHANGED. A human must review and approve this exact plan in a terminal: commerceweave-mcp approve ${p.id}   (then call commerce_execute_proposal). The model cannot approve it.`
        : 'NOTHING HAS BEEN CHANGED. Server is in proposal mode: this plan cannot be executed. Set COMMERCEWEAVE_MODE=approval_required to allow human-approved execution.',
    };
  }

  async prepareStock(connectionId: string, items: StockItem[], signal?: AbortSignal) {
    const c = this.reg.get(connectionId);
    this.guard(c, items.length);
    const changes: PlannedChange[] = [];
    const warnings: string[] = [];
    for (const it of items) {
      if (!Number.isInteger(it.quantity) || it.quantity < 0 || it.quantity > 1_000_000) throw new CommerceError('VALIDATION_FAILED', `Invalid quantity ${it.quantity}`);
      const op: WriteOperation = { kind: 'stock', ...it };
      const before = await c.readCurrent(op, signal);
      const label = `${it.productId}${it.variantId ? '/' + it.variantId : ''} — ${before.description}`;
      before.warnings?.forEach((w) => warnings.push(`${it.productId}: ${w}`));
      const delta = Number.isFinite(Number(before.value)) ? ` (${it.quantity - Number(before.value) >= 0 ? '+' : ''}${it.quantity - Number(before.value)})` : '';
      changes.push({ op, before, expectedAfter: String(it.quantity), label, beforeDisplay: before.value, afterDisplay: `${it.quantity}${delta}` });
    }
    return this.finish(c, `Set stock on ${changes.length} item(s) in ${c.id}`, changes, warnings);
  }

  async preparePrice(connectionId: string, items: PriceItem[], signal?: AbortSignal) {
    const c = this.reg.get(connectionId);
    this.guard(c, items.length);
    const changes: PlannedChange[] = [];
    const warnings: string[] = ['Prices are rounded half-up to 2 decimals using exact decimal arithmetic.'];
    for (const it of items) {
      if ((it.newPrice === undefined) === (it.changePercent === undefined)) throw new CommerceError('VALIDATION_FAILED', 'Give exactly one of newPrice or changePercent per item.');
      const probe: WriteOperation = { kind: 'price', productId: it.productId, variantId: it.variantId, catalogId: it.catalogId, priceGroup: it.priceGroup, amount: '0' };
      const before = await c.readCurrent(probe, signal);
      let next: bigint;
      if (it.newPrice !== undefined) next = roundDecimal(parseDecimal(it.newPrice), 2);
      else {
        const pct = parseDecimal(it.changePercent as string);
        if (pct < -90n * 1_000_000n || pct > 500n * 1_000_000n) throw new CommerceError('VALIDATION_FAILED', 'changePercent must be between -90 and 500');
        if (before.value === '') throw new CommerceError('AMBIGUOUS_TARGET', `${it.productId} has no current price to apply a percentage to`);
        next = roundDecimal(applyPercent(parseDecimal(before.value), it.changePercent as string), 2);
      }
      if (next <= 0n) throw new CommerceError('VALIDATION_FAILED', `Resulting price for ${it.productId} would be ${formatDecimal(next)}; must be > 0`);
      const after = formatDecimal(next, 2);
      before.warnings?.forEach((w) => warnings.push(`${it.productId}: ${w}`));
      const cur = before.currency ?? null;
      const op: WriteOperation = { kind: 'price', productId: it.productId, variantId: it.variantId, catalogId: it.catalogId, priceGroup: it.priceGroup, amount: after, currency: cur };
      const delta = before.value !== '' ? next - parseDecimal(before.value) : undefined;
      const diff = delta === undefined ? 'n/a' : `${delta >= 0n ? '+' : ''}${formatDecimal(delta, 2)}`;
      changes.push({ op, before, expectedAfter: after, label: `${it.productId}${it.variantId ? '/' + it.variantId : ''} — ${before.description}`, beforeDisplay: `${before.value ? normalizeMoney(before.value) : '(none)'} ${cur ?? '(currency not reported)'}`, afterDisplay: `${after} ${cur ?? ''} (${diff})`.trim() });
    }
    return this.finish(c, `Change price on ${changes.length} item(s) in ${c.id}`, changes, warnings);
  }

  async prepareOrderStatus(connectionId: string, orderId: string, status: string, signal?: AbortSignal) {
    const c = this.reg.get(connectionId);
    this.guard(c, 1);
    const allowed = await c.orderStatuses?.(signal);
    if (allowed && !allowed.some((s) => s.id === status)) throw new CommerceError('VALIDATION_FAILED', `Unknown status "${status}" for ${c.id}. Allowed: ${allowed.map((s) => s.id === s.name ? s.id : `${s.id} (${s.name})`).join(', ')}`);
    const op: WriteOperation = { kind: 'order_status', orderId, status };
    const before = await c.readCurrent(op, signal);
    const name = allowed?.find((s) => s.id === status)?.name ?? status;
    return this.finish(c, `Change status of order ${orderId} in ${c.id}`, [{ op, before, expectedAfter: status, label: `order ${orderId} — ${before.description}`, beforeDisplay: before.value, afterDisplay: `${status}${name !== status ? ` (${name})` : ''}` }], before.warnings ?? []);
  }

  /** Executes a human-approved proposal exactly once. */
  async execute(proposalId: string, signal?: AbortSignal) {
    if (this.mode !== 'approval_required') throw new CommerceError('MODE_FORBIDS', `Execution requires COMMERCEWEAVE_MODE=approval_required (current: ${this.mode}).`);
    const p = this.store.get(proposalId);
    if (p.status !== 'pending') throw new CommerceError('APPROVAL_INVALID', `Proposal ${p.id} is already ${p.status}; approvals are single-use.`);
    if (Date.parse(p.expiresAt) < Date.now()) throw new CommerceError('APPROVAL_INVALID', `Proposal ${p.id} expired at ${p.expiresAt}.`);
    this.store.verifyApproval(p);
    // Claim the single-use approval and persist "executing" BEFORE any await: concurrent calls lose the race here,
    // and a crash can never replay the plan.
    this.store.claimApproval(p.id);
    p.status = 'executing';
    this.store.save(p);
    this.store.audit({ event: 'execute_start', proposalId: p.id, connectionId: p.connectionId, changes: p.changes.length });

    const abort = (message: string, code: 'STALE_PROPOSAL' | 'MODE_FORBIDS' | 'APPROVAL_INVALID', label = 'precheck'): never => {
      p.status = 'failed';
      p.result = { at: new Date().toISOString(), outcomes: [{ label, ok: false, detail: message }] };
      this.store.save(p);
      this.store.audit({ event: 'execute_aborted', proposalId: p.id, code });
      throw new CommerceError(code, message, { connectionId: p.connectionId });
    };
    const c = this.reg.get(p.connectionId);
    if (p.platform !== c.platform) abort('Connection platform changed since the proposal was created.', 'APPROVAL_INVALID');
    if (!c.writable) abort(`Connection ${c.id} is read-only.`, 'MODE_FORBIDS');

    // Re-read everything BEFORE touching anything: abort on any drift.
    const fresh: CurrentState[] = [];
    for (const ch of p.changes) {
      const now = await c.readCurrent(ch.op, signal);
      if (!sameValue(now.value, ch.before.value)) {
        abort(`State changed since the proposal was created for "${ch.label}": was ${ch.before.value}, now ${now.value}. Nothing was executed; the approval is spent, create a new proposal.`, 'STALE_PROPOSAL', ch.label);
      }
      fresh.push(now);
    }

    const outcomes: Array<{ label: string; ok: boolean; detail: string }> = [];
    let failed = false;
    for (const [i, ch] of p.changes.entries()) {
      if (failed) { outcomes.push({ label: ch.label, ok: false, detail: 'skipped after an earlier failure' }); continue; }
      try {
        const r = await c.write(ch.op, fresh[i] as CurrentState, signal);
        const after = await c.readCurrent(ch.op, signal);
        const verified = sameValue(after.value, ch.expectedAfter);
        outcomes.push({ label: ch.label, ok: r.applied && verified, detail: verified ? `${r.detail}; verified: ${after.value}` : `${r.detail}; VERIFICATION FAILED: expected ${ch.expectedAfter}, platform reports ${after.value}` });
        if (!(r.applied && verified)) failed = true;
      } catch (e) {
        const ce = toCommerceError(e);
        outcomes.push({ label: ch.label, ok: false, detail: `${ce.code}: ${ce.message}` });
        failed = true;
      }
    }
    p.status = failed ? 'failed' : 'executed';
    p.result = { at: new Date().toISOString(), outcomes };
    this.store.save(p);
    this.store.audit({ event: 'execute_end', proposalId: p.id, connectionId: c.id, status: p.status, outcomes: outcomes.map((o) => ({ ok: o.ok })) });
    log('info', `proposal ${p.id} ${p.status}`);
    return this.describe(p);
  }
}
