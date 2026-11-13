import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AllegroConnector } from '../../src/connectors/allegro/index.js';
import { BaseConnector } from '../../src/connectors/baselinker/index.js';
import { WooConnector } from '../../src/connectors/woocommerce/index.js';
import { CommerceError } from '../../src/core/errors.js';
import { TokenStore } from '../../src/core/token-store.js';
import { startFakeAllegro, AL_CLIENT_ID, AL_CLIENT_SECRET, type AllegroFake } from '../helpers/fake-allegro.js';
import { BASE_TOKEN, startFakeBase } from '../helpers/fake-base.js';
import { startFakeWoo, WOO_KEY, WOO_SECRET } from '../helpers/fake-woo.js';
import { tmpHome } from '../helpers/mcp.js';

const noSleep = async () => undefined;
const range = { from: new Date('2020-01-01'), to: new Date('2030-01-01'), includePersonalData: false, maxOrders: 100 };

async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e, `expected CommerceError ${code}`).toBeInstanceOf(CommerceError);
  expect((e as CommerceError).code).toBe(code);
  return e as CommerceError;
}

describe('WooCommerce connector (real HTTP against a local WC REST v3 server)', () => {
  let srv: Awaited<ReturnType<typeof startFakeWoo>>;
  const mk = (key = WOO_KEY, secret = WOO_SECRET) => new WooConnector({ platform: 'woocommerce', id: 'woo', storeUrl: srv.url, consumerKey: key, consumerSecret: secret, allowInsecure: true }, true, { sleep: noSleep });
  beforeAll(async () => { srv = await startFakeWoo(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { srv.calls.length = 0; srv.fail.times = 0; });

  it('lists products with pagination, currency and variations kept separate', async () => {
    const c = mk();
    const p1 = await c.listProducts({ limit: 2, page: 1, includeVariants: true });
    expect(p1.products).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBe(3);
    const p2 = await c.listProducts({ limit: 2, page: 2, includeVariants: true });
    const tee = p2.products[0]!;
    expect(tee.kind).toBe('variable');
    expect(tee.variants?.map((v) => v.sku)).toEqual(['TEE-S', 'TEE-M', 'TEE-L']);
    expect(tee.variants?.[0]?.inventory.total).toBe(10);
    expect(tee.variants?.[2]?.inventory).toMatchObject({ managed: false, total: null }); // inherits from parent
    expect(p1.products[0]?.prices[0]).toEqual({ amount: '39.90', currency: 'PLN', group: 'regular', onSale: false });
  });

  it('sends credentials only in the Authorization header, never in the URL', async () => {
    await mk().listProducts({ limit: 1, page: 1 });
    expect(srv.calls.every((x) => !x.path.includes(WOO_KEY) && !x.path.includes(WOO_SECRET))).toBe(true);
    expect(String(srv.calls[0]?.headers.authorization)).toMatch(/^Basic /);
  });

  it('maps wrong credentials to AUTH_FAILED without leaking them', async () => {
    const e = await expectCode(mk('ck_bad', 'cs_bad').listProducts({ limit: 1, page: 1 }), 'AUTH_FAILED');
    expect(e.message).not.toContain('cs_bad');
  });

  it('normalizes orders and masks personal data by default', async () => {
    const r = await mk().listOrders(range);
    const o = r.orders[0]!;
    expect(o).toMatchObject({ state: 'open', total: { amount: '79.80', currency: 'PLN' } });
    expect(o.customer.redacted).toBe(true);
    expect(JSON.stringify(o)).not.toContain('buyer@example.invalid');
    expect(o.untrustedText?.buyerNote).toMatch(/redacted/);
    expect(r.orders[1]?.state).toBe('cancelled');
    const full = await mk().getOrder('501', true);
    expect(full.customer.email).toBe('buyer@example.invalid');
  });

  it('retries reads on 429 honouring Retry-After and on 500, then succeeds', async () => {
    srv.fail = { status: 429, times: 2, retryAfter: 0 };
    const r = await mk().listProducts({ limit: 1, page: 1 });
    expect(r.products).toHaveLength(1);
    expect(srv.calls.filter((c) => c.path.startsWith('/wp-json/wc/v3/products?')).length).toBe(3);
    srv.fail = { status: 500, times: 1, retryAfter: 0 };
    expect((await mk().listProducts({ limit: 1, page: 1 })).products).toHaveLength(1);
  });

  it('gives up with RATE_LIMITED after repeated 429', async () => {
    srv.fail = { status: 429, times: 99, retryAfter: 0 };
    await expectCode(mk().listProducts({ limit: 1, page: 1 }), 'RATE_LIMITED');
  });

  it('reports 403 as PERMISSION_DENIED and 404 as NOT_FOUND', async () => {
    srv.fail = { status: 403, times: 1 };
    await expectCode(mk().listProducts({ limit: 1, page: 1 }), 'PERMISSION_DENIED');
    await expectCode(mk().getProduct('99999'), 'NOT_FOUND');
  });

  it('refuses ambiguous write targets: variable parent without variantId', async () => {
    await expectCode(mk().readCurrent({ kind: 'stock', productId: '20', quantity: 1 }), 'AMBIGUOUS_TARGET');
    const cur = await mk().readCurrent({ kind: 'stock', productId: '20', variantId: '201', quantity: 1 });
    expect(cur.value).toBe('10');
  });

  it('warns when a sale price exists and targets the regular price', async () => {
    const cur = await mk().readCurrent({ kind: 'price', productId: '12', amount: '1' });
    expect(cur.value).toBe('129.00');
    expect(cur.warnings?.[0]).toMatch(/sale price/);
  });

  it('rejects insecure or private store URLs unless explicitly allowed', () => {
    const base = { platform: 'woocommerce' as const, id: 'w', consumerKey: 'k', consumerSecret: 's', allowInsecure: false };
    expect(() => new WooConnector({ ...base, storeUrl: 'http://shop.example.com' }, false)).toThrow(/https/);
    expect(() => new WooConnector({ ...base, storeUrl: 'https://127.0.0.1' }, false)).toThrow(/private/);
    expect(() => new WooConnector({ ...base, storeUrl: 'https://user:pw@shop.example.com' }, false)).toThrow(/credentials/);
  });
});

describe('Base.com connector (X-BLToken, connector.php, errors inside HTTP 200)', () => {
  let srv: Awaited<ReturnType<typeof startFakeBase>>;
  const mk = (token = BASE_TOKEN) => new BaseConnector({ platform: 'baselinker', id: 'base', token, apiUrl: `${srv.url}/connector.php` }, true, { sleep: noSleep });
  beforeAll(async () => { srv = await startFakeBase(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { srv.calls.length = 0; });

  it('sends method/parameters form body with the token in a header, not the body', async () => {
    await mk().listProducts({ limit: 10, page: 1 });
    const call = srv.calls.find((c) => c.body?.method === 'getInventoryProductsList')!;
    expect(call.headers['x-bltoken']).toBe(BASE_TOKEN);
    expect(JSON.stringify(call.body)).not.toContain(BASE_TOKEN);
    expect(call.headers['content-type']).toContain('application/x-www-form-urlencoded');
  });

  it('groups variants under parents and keeps per-warehouse stock', async () => {
    const r = await mk().listProducts({ limit: 10, page: 1 });
    const mug = r.products.find((p) => p.sku === 'MUG-01')!;
    expect(mug.inventory).toMatchObject({ total: 14, byLocation: { bl_206: 5, bl_207: 9 } });
    const tee = r.products.find((p) => p.sku === 'TEE')!;
    expect(tee.kind).toBe('variable');
    expect(tee.variants?.[0]).toMatchObject({ sku: 'TEE-S', source: { externalId: '2687' } });
  });

  it('turns API errors delivered with HTTP 200 into typed errors', async () => {
    const e = await expectCode(mk('1-1-WRONGTOKEN').listProducts({ limit: 1, page: 1 }), 'AUTH_FAILED');
    expect(e.message).not.toContain('WRONGTOKEN');
  });

  it('maps Base query-limit errors to RATE_LIMITED', async () => {
    const limited = await startFakeBase({ rateLimitFirst: 5 });
    const c = new BaseConnector({ platform: 'baselinker', id: 'b', token: BASE_TOKEN, apiUrl: `${limited.url}/connector.php` }, false, { sleep: noSleep });
    await expectCode(c.listProducts({ limit: 1, page: 1 }), 'RATE_LIMITED');
    await limited.close();
  });

  it('computes order totals with exact decimals and flags marketplace imports', async () => {
    const o = (await mk().listOrders({ ...range, from: new Date(0), to: new Date('2100-01-01') })).orders[0]!;
    expect(o.total).toEqual({ amount: '89.79', currency: 'PLN' }); // 2 x 39.90 + 9.99 delivery
    expect(o.importedFrom).toEqual({ system: 'allegro', externalOrderId: 'ALLEGRO-UUID-1' });
    expect(o.stateClassified).toBe(false); // custom Base status without a configured statusMap
    expect(o.customer.redacted).toBe(true);
    expect(JSON.stringify(o)).not.toContain('Real Name');
  });

  it('requires an explicit warehouse when stock exists in several', async () => {
    await expectCode(mk().readCurrent({ kind: 'stock', productId: '2685', quantity: 1 }), 'AMBIGUOUS_TARGET');
    const cur = await mk().readCurrent({ kind: 'stock', productId: '2685', locationId: 'bl_207', quantity: 1 });
    expect(cur.value).toBe('9');
  });
});

describe('Allegro connector (OAuth2 refresh + async command API)', () => {
  let srv: AllegroFake;
  let home: string;
  const mk = (writable = true) => {
    const store = new TokenStore(home);
    store.save('allegro', { accessToken: srv.tokens.access, refreshToken: srv.tokens.refresh, expiresAt: Date.now() + 3_600_000 });
    return { store, c: new AllegroConnector({ platform: 'allegro', id: 'allegro', environment: 'sandbox', clientId: AL_CLIENT_ID, clientSecret: AL_CLIENT_SECRET, apiUrl: srv.url, authUrl: srv.url }, writable, store, { sleep: noSleep, pollIntervalMs: 1 }) };
  };
  beforeAll(async () => { srv = await startFakeAllegro(); });
  afterAll(async () => { await srv.close(); });
  beforeEach(() => { home = tmpHome(); srv.calls.length = 0; srv.failCommand = false; srv.commandPollsNeeded = 2; });

  it('reads offers, price and stock as exact values', async () => {
    const { c } = mk();
    const r = await c.listProducts({ limit: 10, page: 1 });
    expect(r.products.map((p) => [p.sku, p.inventory.total, p.prices[0]?.amount])).toEqual([['MUG-01', 14, '39.90'], ['LAMP-02', 3, '129.00']]);
    expect((await c.getOffer('1001')).price).toEqual({ amount: '39.90', currency: 'PLN' });
    expect((await c.accountInfo()).login).toBe('sandbox-seller');
  });

  it('refreshes an expired access token and persists the rotated refresh token', async () => {
    const { c, store } = mk();
    const before = srv.tokens.refreshCount;
    store.save('allegro', { accessToken: 'stale', refreshToken: srv.tokens.refresh, expiresAt: Date.now() - 1000 });
    await c.accountInfo();
    expect(srv.tokens.refreshCount).toBe(before + 1);
    expect(store.load('allegro')?.refreshToken).toBe(srv.tokens.refresh);
    await c.accountInfo(); // no second refresh needed
    expect(srv.tokens.refreshCount).toBe(before + 1);
  });

  it('recovers from a server-side 401 with one refresh for reads', async () => {
    const { c, store } = mk();
    store.save('allegro', { accessToken: 'revoked-but-unexpired', refreshToken: srv.tokens.refresh, expiresAt: Date.now() + 3_600_000 });
    expect((await c.accountInfo()).id).toBe('u1');
  });

  it('reports a missing authorization with a setup hint', async () => {
    const store = new TokenStore(tmpHome());
    const c = new AllegroConnector({ platform: 'allegro', id: 'allegro', environment: 'sandbox', clientId: AL_CLIENT_ID, clientSecret: AL_CLIENT_SECRET, apiUrl: srv.url, authUrl: srv.url }, false, store);
    const e = await expectCode(c.accountInfo(), 'AUTH_FAILED');
    expect(e.message).toMatch(/setup allegro/);
  });

  it('completes the device flow, including authorization_pending', async () => {
    const { c, store } = mk();
    const fresh = new TokenStore(tmpHome());
    const c2 = new AllegroConnector({ platform: 'allegro', id: 'allegro', environment: 'sandbox', clientId: AL_CLIENT_ID, clientSecret: AL_CLIENT_SECRET, apiUrl: srv.url, authUrl: srv.url }, false, fresh, { sleep: noSleep });
    void c; void store;
    const code = await c2.auth.startDeviceFlow();
    expect(code.user_code).toBe('ABCD-1234');
    const t = await c2.auth.completeDeviceFlow(code);
    expect(t.accessToken).toBeTruthy();
    expect(fresh.load('allegro')?.refreshToken).toBe(t.refreshToken);
  });

  it('normalizes orders; unpaid vs paid and PII masking', async () => {
    const { c } = mk();
    const o = (await c.listOrders(range)).orders[0]!;
    expect(o).toMatchObject({ state: 'open', total: { amount: '39.90', currency: 'PLN' } });
    expect(JSON.stringify(o)).not.toContain('real@example.invalid');
    expect(o.untrustedText?.buyerNote).toMatch(/redacted/);
  });

  it('runs the async price command: request -> command id -> poll -> task result', async () => {
    const { c } = mk();
    const cur = await c.readCurrent({ kind: 'price', productId: '1001', amount: '41.90' });
    const r = await c.write({ kind: 'price', productId: '1001', amount: '41.90', currency: 'PLN' }, cur);
    expect(r.detail).toMatch(/succeeded/);
    const put = srv.calls.find((x) => x.method === 'PUT' && x.path.includes('offer-price-change-commands'))!;
    expect(put.body.modification).toEqual({ type: 'FIXED_PRICE', price: { amount: '41.90', currency: 'PLN' } });
    expect(srv.calls.filter((x) => x.method === 'GET' && /offer-price-change-commands\/[\w-]+$/.test(x.path)).length).toBeGreaterThanOrEqual(2); // 201 is not "done"
    expect((await c.getOffer('1001')).price?.amount).toBe('41.90');
  });

  it('surfaces a failed command task instead of pretending success', async () => {
    const { c } = mk();
    srv.failCommand = true;
    const cur = await c.readCurrent({ kind: 'stock', productId: '1002', quantity: 1 });
    const e = await expectCode(c.write({ kind: 'stock', productId: '1002', quantity: 1 }, cur), 'VALIDATION_FAILED');
    expect(e.message).toMatch(/Price too low/);
  });

  it('reports an unknown outcome when a command never completes', async () => {
    const { c } = mk();
    const slow = new AllegroConnector({ platform: 'allegro', id: 'allegro', environment: 'sandbox', clientId: AL_CLIENT_ID, clientSecret: AL_CLIENT_SECRET, apiUrl: srv.url, authUrl: srv.url }, true, new TokenStore(home), { sleep: noSleep, pollIntervalMs: 1, pollTimeoutMs: 30 });
    srv.commandPollsNeeded = 10_000;
    const cur = await c.readCurrent({ kind: 'stock', productId: '1001', quantity: 2 });
    await expectCode(slow.write({ kind: 'stock', productId: '1001', quantity: 2 }, cur), 'WRITE_OUTCOME_UNKNOWN');
  });

  it('uses the order revision for optimistic concurrency on status changes', async () => {
    const { c } = mk();
    const cur = await c.readCurrent({ kind: 'order_status', orderId: 'aaaa-1', status: 'SENT' });
    expect(cur.revision).toBe('rev1');
    await c.write({ kind: 'order_status', orderId: 'aaaa-1', status: 'SENT' }, cur);
    expect((await c.getOrder('aaaa-1', false)).state).toBe('fulfilled');
    await expectCode(c.write({ kind: 'order_status', orderId: 'aaaa-1', status: 'PROCESSING' }, { ...cur, revision: 'old' }), 'VALIDATION_FAILED');
  });

  it('blocks writes on connections configured read-only', async () => {
    const { c } = mk(false);
    await expectCode(c.write({ kind: 'stock', productId: '1001', quantity: 1 }, { value: '14', description: '' }), 'MODE_FORBIDS');
  });
});
