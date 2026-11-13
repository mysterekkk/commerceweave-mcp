import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AllegroConnector } from '../../src/connectors/allegro/index.js';
import { Registry } from '../../src/connectors/registry.js';
import { WooConnector } from '../../src/connectors/woocommerce/index.js';
import { ApprovalStore } from '../../src/core/approvals.js';
import { CommerceError } from '../../src/core/errors.js';
import { TokenStore } from '../../src/core/token-store.js';
import { Writes } from '../../src/unified/writes.js';
import { AL_CLIENT_ID, AL_CLIENT_SECRET, startFakeAllegro, type AllegroFake } from '../helpers/fake-allegro.js';
import { startFakeWoo, WOO_KEY, WOO_SECRET } from '../helpers/fake-woo.js';
import { tmpHome } from '../helpers/mcp.js';

const noSleep = async () => undefined;
async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(CommerceError);
  return (e as CommerceError).code;
}

describe('offer publication (Allegro) and draft products (WooCommerce) through approved proposals', () => {
  let al: AllegroFake;
  let woo: Awaited<ReturnType<typeof startFakeWoo>>;
  let writes: Writes;
  let store: ApprovalStore;

  beforeAll(async () => {
    al = await startFakeAllegro();
    woo = await startFakeWoo();
    const home = tmpHome();
    const tokens = new TokenStore(home);
    tokens.save('allegro', { accessToken: al.tokens.access, refreshToken: al.tokens.refresh, expiresAt: Date.now() + 3_600_000 });
    const reg = new Registry([
      new AllegroConnector({ platform: 'allegro', id: 'allegro', environment: 'sandbox', clientId: AL_CLIENT_ID, clientSecret: AL_CLIENT_SECRET, apiUrl: al.url, authUrl: al.url }, true, tokens, { sleep: noSleep, pollIntervalMs: 1 }),
      new WooConnector({ platform: 'woocommerce', id: 'woo', storeUrl: woo.url, consumerKey: WOO_KEY, consumerSecret: WOO_SECRET, allowInsecure: true }, true, { sleep: noSleep }),
    ]);
    store = new ApprovalStore(home, 600_000);
    writes = new Writes(reg, store, 'approval_required');
  });
  afterAll(async () => {
    await al.close();
    await woo.close();
  });

  it('ending an offer: warns, needs approval, uses the publication command API, verified', async () => {
    const p = await writes.prepareOfferPublication('allegro', '1001', 'END');
    expect(p.changes[0]).toMatchObject({ before: 'ACTIVE', after: 'ENDED' });
    expect(p.warnings.join(' ')).toMatch(/removes it from sale/);
    expect(await code(writes.execute(p.proposalId))).toBe('APPROVAL_REQUIRED');
    store.recordHumanApproval(p.proposalId);
    const r = await writes.execute(p.proposalId);
    expect(r.status).toBe('executed');
    const put = al.calls.find((c) => c.method === 'PUT' && c.path.includes('offer-publication-commands'))!;
    expect(put.body).toMatchObject({ publication: { action: 'END' }, offerCriteria: [{ offers: [{ id: '1001' }], type: 'CONTAINS_OFFERS' }] });
    expect(al.state.offers.find((o: { id: string }) => o.id === '1001').publication.status).toBe('ENDED');
  });

  it('re-activating warns about fees and a no-op is flagged', async () => {
    const p = await writes.prepareOfferPublication('allegro', '1001', 'ACTIVATE');
    expect(p.warnings.join(' ')).toMatch(/fees/);
    store.recordHumanApproval(p.proposalId);
    expect((await writes.execute(p.proposalId)).status).toBe('executed');
    const again = await writes.prepareOfferPublication('allegro', '1001', 'ACTIVATE');
    expect(again.warnings.join(' ')).toMatch(/already active/);
  });

  it('publication is Allegro-only', async () => {
    expect(await code(writes.prepareOfferPublication('woo', '11', 'END'))).toBe('NOT_SUPPORTED');
  });

  it('creates a DRAFT product only: status draft, price exact, never overwrites an existing SKU', async () => {
    const p = await writes.prepareProductDraft('woo', { sku: 'NEW-100', name: 'New mug', regularPrice: '19.9', stockQuantity: 5 });
    expect(p.changes[0]?.after).toContain('DRAFT');
    expect(p.changes[0]?.after).toContain('19.90');
    expect(p.warnings.join(' ')).toMatch(/not visible in the shop/);
    store.recordHumanApproval(p.proposalId);
    expect((await writes.execute(p.proposalId)).status).toBe('executed');
    const post = woo.calls.find((c) => c.method === 'POST' && c.path.endsWith('/products'))!;
    expect(post.body).toMatchObject({ status: 'draft', sku: 'NEW-100', regular_price: '19.90', manage_stock: true, stock_quantity: 5, type: 'simple' });
    expect(await code(writes.prepareProductDraft('woo', { sku: 'NEW-100', name: 'Again', regularPrice: '1' }))).toBe('VALIDATION_FAILED');
    expect(await code(writes.prepareProductDraft('woo', { sku: 'MUG-01', name: 'Clash', regularPrice: '1' }))).toBe('VALIDATION_FAILED');
  });

  it('draft input is validated and platform support is explicit', async () => {
    expect(await code(writes.prepareProductDraft('woo', { sku: 'bad sku!', name: 'x', regularPrice: '1' }))).toBe('VALIDATION_FAILED');
    expect(await code(writes.prepareProductDraft('woo', { sku: 'OK-1', name: 'x', regularPrice: '0' }))).toBe('VALIDATION_FAILED');
    expect(await code(writes.prepareProductDraft('woo', { sku: 'OK-1', name: 'x' + String.fromCharCode(10) + 'y', regularPrice: '1' }))).toBe('VALIDATION_FAILED');
    expect(await code(writes.prepareProductDraft('allegro', { sku: 'OK-1', name: 'x', regularPrice: '1' }))).toBe('NOT_SUPPORTED');
  });

  it('a draft proposal goes stale if the SKU appears before execution', async () => {
    const p = await writes.prepareProductDraft('woo', { sku: 'RACE-1', name: 'Race', regularPrice: '3' });
    store.recordHumanApproval(p.proposalId);
    woo.state.products.push({ id: 7777, name: 'Someone else', type: 'simple', status: 'publish', sku: 'RACE-1', regular_price: '1', price: '1', manage_stock: false, stock_quantity: null, stock_status: 'instock' });
    expect(await code(writes.execute(p.proposalId))).toBe('STALE_PROPOSAL');
    expect(woo.calls.filter((c) => c.method === 'POST' && c.body?.sku === 'RACE-1')).toHaveLength(0);
  });
});
