import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseConnector } from '../../src/connectors/baselinker/index.js';
import { Registry } from '../../src/connectors/registry.js';
import { ApprovalStore } from '../../src/core/approvals.js';
import { CommerceError } from '../../src/core/errors.js';
import { Writes } from '../../src/unified/writes.js';
import { BASE_TOKEN, startFakeBase } from '../helpers/fake-base.js';
import { tmpHome } from '../helpers/mcp.js';

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(CommerceError);
  return (e as CommerceError).code;
}

describe('Base.com product creation through approved proposals', () => {
  let base: Awaited<ReturnType<typeof startFakeBase>>;
  let writes: Writes;
  let store: ApprovalStore;

  beforeAll(async () => {
    base = await startFakeBase();
    const reg = new Registry([new BaseConnector({ platform: 'baselinker', id: 'base', token: BASE_TOKEN, apiUrl: `${base.url}/connector.php` }, true, { sleep: async () => undefined })]);
    store = new ApprovalStore(tmpHome(), 600_000);
    writes = new Writes(reg, store, 'approval_required');
  });
  afterAll(async () => {
    await base.close();
  });

  it('plans, needs approval, creates exactly one product with the right catalog, price group and warehouse, verified', async () => {
    const p = await writes.prepareProductDraft('base', { sku: 'NEW-B1', name: 'Brand new mug', regularPrice: '24.5', stockQuantity: 7, locationId: 'bl_206' });
    expect(p.changes[0]).toMatchObject({ before: '(does not exist)' });
    expect(p.changes[0]?.after).toContain('24.50');
    expect(p.warnings.join(' ')).toMatch(/not linked to any marketplace/);
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_REQUIRED');
    expect(base.calls.some((c) => c.body?.method === 'addInventoryProduct')).toBe(false);
    store.recordHumanApproval(p.proposalId);
    expect((await writes.execute(p.proposalId)).status).toBe('executed');
    const adds = base.calls.filter((c) => c.body?.method === 'addInventoryProduct');
    expect(adds).toHaveLength(1);
    expect(JSON.parse(adds[0]?.body.parameters)).toEqual({ inventory_id: 307, sku: 'NEW-B1', text_fields: { name: 'Brand new mug' }, prices: { '105': 24.5 }, stock: { bl_206: 7 } });
    expect(Object.values(base.state.products).some((x) => (x as { sku: string }).sku === 'NEW-B1')).toBe(true);
  });

  it('never updates an existing product: an existing SKU is refused', async () => {
    expect(await code(writes.prepareProductDraft('base', { sku: 'MUG-01', name: 'Clash', regularPrice: '1' }))).toBe('VALIDATION_FAILED');
    expect(await code(writes.prepareProductDraft('base', { sku: 'NEW-B1', name: 'Again', regularPrice: '1' }))).toBe('VALIDATION_FAILED');
  });

  it('requires an explicit warehouse when several exist and validates the chosen ones', async () => {
    expect(await code(writes.prepareProductDraft('base', { sku: 'NEW-B2', name: 'x', regularPrice: '1', stockQuantity: 1 }))).toBe('AMBIGUOUS_TARGET');
    expect(await code(writes.prepareProductDraft('base', { sku: 'NEW-B2', name: 'x', regularPrice: '1', stockQuantity: 1, locationId: 'bl_999' }))).toBe('NOT_FOUND');
    expect(await code(writes.prepareProductDraft('base', { sku: 'NEW-B2', name: 'x', regularPrice: '1', priceGroup: '777' }))).toBe('NOT_FOUND');
    // no stock requested: the warehouse is not needed
    const ok = await writes.prepareProductDraft('base', { sku: 'NEW-B3', name: 'No stock', regularPrice: '2' });
    expect(ok.status).toBe('pending');
  });

  it('goes stale if the SKU appears between proposal and execution', async () => {
    const p = await writes.prepareProductDraft('base', { sku: 'NEW-B4', name: 'Race', regularPrice: '2' });
    store.recordHumanApproval(p.proposalId);
    base.state.products['9999'] = { id: 9999, parent_id: 0, ean: '', sku: 'NEW-B4', name: 'other', prices: { '105': 1 }, stock: {} };
    expect(await code(writes.execute(p.proposalId))).toBe('STALE_PROPOSAL');
    expect(base.calls.filter((c) => c.body?.method === 'addInventoryProduct')).toHaveLength(1); // only the first test's creation
  });
});
