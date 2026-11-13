import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BaseConnector } from '../../src/connectors/baselinker/index.js';
import { Registry } from '../../src/connectors/registry.js';
import { WooConnector } from '../../src/connectors/woocommerce/index.js';
import { ApprovalStore } from '../../src/core/approvals.js';
import type { Mode } from '../../src/core/config.js';
import { CommerceError } from '../../src/core/errors.js';
import { Writes } from '../../src/unified/writes.js';
import { BASE_TOKEN, startFakeBase } from '../helpers/fake-base.js';
import { startFakeWoo, WOO_KEY, WOO_SECRET, wooFixtures } from '../helpers/fake-woo.js';
import { tmpHome } from '../helpers/mcp.js';

const noSleep = async () => undefined;
type Woo = Awaited<ReturnType<typeof startFakeWoo>>;
type Base = Awaited<ReturnType<typeof startFakeBase>>;

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(CommerceError);
  return (e as CommerceError).code;
}

describe('write safety: modes, approvals, execution', () => {
  let woo: Woo;
  let base: Base;
  let home: string;
  const puts = (s: { calls: Array<{ method: string }> }) => s.calls.filter((c) => c.method === 'PUT' || c.method === 'POST' && false).length;

  const build = (mode: Mode, ttlMs = 600_000, writable = true) => {
    const reg = new Registry([
      new WooConnector({ platform: 'woocommerce', id: 'woo', storeUrl: woo.url, consumerKey: WOO_KEY, consumerSecret: WOO_SECRET, allowInsecure: true }, writable, { sleep: noSleep }),
      new BaseConnector({ platform: 'baselinker', id: 'base', token: BASE_TOKEN, apiUrl: `${base.url}/connector.php` }, writable, { sleep: noSleep }),
    ]);
    const store = new ApprovalStore(home, ttlMs);
    return { reg, store, writes: new Writes(reg, store, mode) };
  };

  beforeAll(async () => { woo = await startFakeWoo(); base = await startFakeBase(); });
  afterAll(async () => { await woo.close(); await base.close(); });
  beforeEach(() => {
    home = tmpHome();
    woo.calls.length = 0; base.calls.length = 0;
    Object.assign(woo.state, {});
    const fx = wooFixtures();
    // reset mutable fake state between tests
    woo.state.products?.splice(0, woo.state.products.length, ...fx.products);
  });

  it('read_only mode: proposals are impossible', async () => {
    const { writes } = build('read_only');
    expect(await code(writes.prepareStock('woo', [{ productId: '11', quantity: 3 }]))).toBe('MODE_FORBIDS');
    expect(puts(woo)).toBe(0);
  });

  it('read-only connection blocks proposals even in approval_required mode', async () => {
    const { writes } = build('approval_required', 600_000, false);
    expect(await code(writes.prepareStock('woo', [{ productId: '11', quantity: 3 }]))).toBe('MODE_FORBIDS');
  });

  it('proposal mode: plan is created with before/after, nothing is written, execution is refused', async () => {
    const { writes } = build('proposal');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    expect(p.changes[0]).toMatchObject({ before: '14', after: '20 (+6)' });
    expect(p.nextStep).toMatch(/NOTHING HAS BEEN CHANGED/);
    expect(await code(writes.execute(p.proposalId))).toBe('MODE_FORBIDS');
    expect(puts(woo)).toBe(0);
  });

  it('the model cannot grant itself approval: execute without a human approval fails and writes nothing', async () => {
    const { writes } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_REQUIRED');
    expect(puts(woo)).toBe(0);
  });

  it('a forged approval record (no access to the key) is rejected', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    const full = store.get(p.proposalId);
    store.recordHumanApproval(p.proposalId); // creates the key file; now overwrite the record with a forged MAC
    const f = join(home, 'approvals', `${p.proposalId}.json`);
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...rec, mac: 'ab'.repeat(32), planHash: full.planHash }));
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_INVALID');
    expect(puts(woo)).toBe(0);
  });

  it('human approval -> single execution -> verified result -> audit entry', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    store.recordHumanApproval(p.proposalId); // what `commerceweave-mcp approve` does after the human types the code
    const r = await writes.execute(p.proposalId);
    expect(r.status).toBe('executed');
    expect(r.result?.outcomes[0]).toMatchObject({ ok: true });
    expect(r.result?.outcomes[0]?.detail).toMatch(/verified: 20/);
    expect(puts(woo)).toBe(1);
    expect(woo.state.products.find((x: { id: number }) => x.id === 11).stock_quantity).toBe(20);
    const audit = readFileSync(join(home, 'audit.log'), 'utf8');
    expect(audit).toContain('execute_end');
    expect(audit).not.toContain(WOO_SECRET);
  });

  it('approval is single-use: a second execute is refused and writes nothing more', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    store.recordHumanApproval(p.proposalId);
    await writes.execute(p.proposalId);
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_INVALID');
    expect(puts(woo)).toBe(1);
  });

  it('concurrent executions race: exactly one wins, one write happens', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    store.recordHumanApproval(p.proposalId);
    const results = await Promise.allSettled([writes.execute(p.proposalId), writes.execute(p.proposalId), writes.execute(p.proposalId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(puts(woo)).toBe(1);
  });

  it('expired approvals are rejected', async () => {
    const { writes, store } = build('approval_required', 30);
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    store.recordHumanApproval(p.proposalId);
    await new Promise((r) => setTimeout(r, 60));
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_INVALID');
    expect(puts(woo)).toBe(0);
  });

  it('an approval is bound to the exact plan: tampering after approval is detected', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    store.recordHumanApproval(p.proposalId);
    const f = join(home, 'proposals', `${p.proposalId}.json`);
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    doc.changes[0].op.quantity = 99999; doc.changes[0].expectedAfter = '99999';
    writeFileSync(f, JSON.stringify(doc));
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_INVALID');
    expect(puts(woo)).toBe(0);
  });

  it('aborts without writing if live state drifted after the proposal (stale)', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    store.recordHumanApproval(p.proposalId);
    woo.state.products.find((x: { id: number }) => x.id === 11).stock_quantity = 1; // someone sold items meanwhile
    expect(await code(writes.execute(p.proposalId))).toBe('STALE_PROPOSAL');
    expect(puts(woo)).toBe(0);
    expect(store.get(p.proposalId).status).toBe('failed');
  });

  it('price proposals use exact decimals and half-up rounding (39.90 +5% = 41.90, 129.00 -2.5% = 125.78)', async () => {
    const { writes } = build('proposal');
    const a = await writes.preparePrice('woo', [{ productId: '11', changePercent: '5' }]);
    expect(a.changes[0]?.after).toMatch(/^41\.90 PLN \(\+2\.00\)$/);
    const b = await writes.preparePrice('woo', [{ productId: '12', changePercent: '-2.5' }]);
    expect(b.changes[0]?.after).toMatch(/^125\.78 PLN/);
    expect(b.warnings.join(' ')).toMatch(/sale price/);
  });

  it('rejects ambiguous or invalid targets while preparing', async () => {
    const { writes } = build('proposal');
    expect(await code(writes.prepareStock('woo', [{ productId: '20', quantity: 1 }]))).toBe('AMBIGUOUS_TARGET'); // variable parent
    expect(await code(writes.preparePrice('woo', [{ productId: '11', newPrice: '-1' as unknown as string }]))).toBe('VALIDATION_FAILED');
    expect(await code(writes.preparePrice('woo', [{ productId: '11', changePercent: '5', newPrice: '10' }]))).toBe('VALIDATION_FAILED');
    expect(await code(writes.preparePrice('woo', [{ productId: '11', changePercent: '-95' }]))).toBe('VALIDATION_FAILED');
    expect(await code(writes.prepareStock('base', [{ productId: '2685', quantity: 1 }]))).toBe('AMBIGUOUS_TARGET'); // two warehouses
  });

  it('Base stock write targets only the chosen warehouse and variant', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('base', [{ productId: '2686', variantId: '2687', locationId: 'bl_206', quantity: 8 }]);
    store.recordHumanApproval(p.proposalId);
    expect((await writes.execute(p.proposalId)).status).toBe('executed');
    const upd = base.calls.find((c) => c.body?.method === 'updateInventoryProductsStock')!;
    expect(JSON.parse(upd.body.parameters)).toEqual({ inventory_id: 307, products: { '2687': { bl_206: 8 } } });
    expect(base.state.products['2685'].stock).toEqual({ bl_206: 5, bl_207: 9 }); // untouched
  });

  it('order status: unknown status rejected up front; valid one executes and verifies', async () => {
    const { writes, store } = build('approval_required');
    expect(await code(writes.prepareOrderStatus('woo', '501', 'shipped-ish'))).toBe('VALIDATION_FAILED');
    const p = await writes.prepareOrderStatus('woo', '501', 'completed');
    store.recordHumanApproval(p.proposalId);
    expect((await writes.execute(p.proposalId)).status).toBe('executed');
    expect(woo.state.orders[0].status).toBe('completed');
  });

  it('writes are never retried: a 500 on the PUT yields WRITE_OUTCOME_UNKNOWN after exactly one attempt', async () => {
    const { reg } = build('approval_required');
    const c = reg.get('woo');
    const op = { kind: 'stock' as const, productId: '11', quantity: 20 };
    const cur = await c.readCurrent(op);
    woo.calls.length = 0;
    woo.fail = { status: 500, times: 5 };
    expect(await code(c.write(op, cur))).toBe('WRITE_OUTCOME_UNKNOWN');
    expect(woo.calls.filter((x) => x.method === 'PUT')).toHaveLength(1);
    woo.fail = { times: 0 };
  });

  it('a failed execution leaves an auditable failed proposal and spends the approval', async () => {
    const { writes, store } = build('approval_required');
    const p = await writes.prepareStock('woo', [{ productId: '11', quantity: 20 }]);
    store.recordHumanApproval(p.proposalId);
    woo.state.products.find((x: { id: number }) => x.id === 11).stock_quantity = 2;
    await code(writes.execute(p.proposalId));
    expect(existsSync(join(home, 'approvals', `${p.proposalId}.json`))).toBe(false);
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_INVALID');
  });
});
