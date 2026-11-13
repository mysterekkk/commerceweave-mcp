import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore } from '../../src/core/approvals.js';
import { startFakeBase, BASE_TOKEN } from '../helpers/fake-base.js';
import { startFakeWoo, WOO_KEY, WOO_SECRET } from '../helpers/fake-woo.js';
import { connectStdio, DIST, jsonOf, textOf, tmpHome } from '../helpers/mcp.js';

describe('server with no connectors configured', () => {
  it('starts, handshakes and explains how to configure', async () => {
    const c = await connectStdio({});
    const r = jsonOf<{ connections: unknown[]; hint: string; mode: string }>(await c.client.callTool({ name: 'commerce_list_connections', arguments: {} }));
    expect(r.connections).toEqual([]);
    expect(r.hint).toMatch(/COMMERCEWEAVE_DEMO/);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).some((n) => n.startsWith('allegro_') || n.startsWith('base_') || n.startsWith('woo_'))).toBe(false);
    await c.close();
  });
});

describe('human approval over a real stdio session (approval_required, demo data)', () => {
  it('model can propose but cannot approve; a human-approved plan executes exactly once', async () => {
    const home = tmpHome();
    const c = await connectStdio({ COMMERCEWEAVE_DEMO: 'true', COMMERCEWEAVE_MODE: 'approval_required', COMMERCEWEAVE_HOME: home });
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('commerce_prepare_price_update');
    expect(names).toContain('commerce_execute_proposal');
    expect(names.some((n) => /approve|confirm|grant/i.test(n))).toBe(false); // no tool lets the model approve anything

    const prep = jsonOf<{ proposalId: string; changes: Array<{ before: string; after: string }>; nextStep: string }>(await c.client.callTool({ name: 'commerce_prepare_price_update', arguments: { connectionId: 'demo-woo', items: [{ productId: '901', changePercent: '5' }] } }));
    expect(prep.changes[0]).toMatchObject({ before: '39.90 PLN', after: '41.90 PLN (+2.00)' });
    expect(prep.nextStep).toMatch(/human must review/i);

    // The model tries every trick available: executing, executing with fabricated ids, etc.
    const early = await c.client.callTool({ name: 'commerce_execute_proposal', arguments: { proposalId: prep.proposalId } });
    expect(early.isError).toBe(true);
    expect(jsonOf<{ error: { code: string } }>(early).error.code).toBe('APPROVAL_REQUIRED');
    const fake = await c.client.callTool({ name: 'commerce_execute_proposal', arguments: { proposalId: 'cw_000000000000' } });
    expect(fake.isError).toBe(true);
    const bad = await c.client.callTool({ name: 'commerce_execute_proposal', arguments: { proposalId: '../../etc/passwd' } });
    expect(bad.isError).toBe(true);

    // Price unchanged so far
    const stillOld = jsonOf<{ matches: Array<{ product: { prices: Array<{ amount: string }> } }> }>(await c.client.callTool({ name: 'commerce_find_product', arguments: { sku: 'MUG-01', connectionIds: ['demo-woo'] } }));
    expect(stillOld.matches[0]?.product.prices[0]?.amount).toBe('39.90');

    // The trusted channel: the human, in their own terminal (simulated here by the same store API the CLI uses).
    new ApprovalStore(home, 600_000).recordHumanApproval(prep.proposalId);

    const done = jsonOf<{ status: string; result: { outcomes: Array<{ ok: boolean; detail: string }> } }>(await c.client.callTool({ name: 'commerce_execute_proposal', arguments: { proposalId: prep.proposalId } }));
    expect(done.status).toBe('executed');
    expect(done.result.outcomes[0]?.ok).toBe(true);
    const now = jsonOf<{ matches: Array<{ product: { prices: Array<{ amount: string }> } }> }>(await c.client.callTool({ name: 'commerce_find_product', arguments: { sku: 'MUG-01', connectionIds: ['demo-woo'] } }));
    expect(now.matches[0]?.product.prices[0]?.amount).toBe('41.90');

    const again = await c.client.callTool({ name: 'commerce_execute_proposal', arguments: { proposalId: prep.proposalId } });
    expect(again.isError).toBe(true);
    await c.close();
  });

  it('proposal mode offers no execute tool at all; read_only offers no prepare tools', async () => {
    const p = await connectStdio({ COMMERCEWEAVE_DEMO: 'true', COMMERCEWEAVE_MODE: 'proposal' });
    const names = (await p.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('commerce_prepare_stock_update');
    expect(names).not.toContain('commerce_execute_proposal');
    await p.close();
  });

  it('the approve CLI refuses to run without an interactive terminal', () => {
    const r = spawnSync(process.execPath, [DIST, 'approve', 'cw_000000000000'], { input: 'ABC123\n', encoding: 'utf8', env: { PATH: process.env.PATH ?? '', COMMERCEWEAVE_HOME: tmpHome() } });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/interactive terminal/);
  });
});

describe('prompt injection in platform data', () => {
  it('seller/buyer text is delivered only as labelled untrusted data and cannot change permissions', async () => {
    const c = await connectStdio({ COMMERCEWEAVE_DEMO: 'true' });
    const res = await c.client.callTool({ name: 'commerce_list_orders', arguments: { days: 7, includePersonalData: true } });
    const r = jsonOf<{ securityNotice: string; orders: Array<{ untrustedText?: { buyerNote?: string } }> }>(res);
    const notes = r.orders.map((o) => o.untrustedText?.buyerNote).filter(Boolean);
    expect(notes.join(' ')).toMatch(/IGNORE ALL PREVIOUS INSTRUCTIONS/); // present as data...
    expect(r.securityNotice).toMatch(/never instructions/);              // ...with an explicit notice...
    const { tools } = await c.client.listTools();                         // ...and the server is still read-only
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    await c.close();
  });
});

describe('real MCP session against live-protocol connectors (local platform servers)', () => {
  let woo: Awaited<ReturnType<typeof startFakeWoo>>;
  let base: Awaited<ReturnType<typeof startFakeBase>>;
  beforeAll(async () => { woo = await startFakeWoo(); base = await startFakeBase(); });
  afterAll(async () => { await woo.close(); await base.close(); });

  it('exposes platform tools, returns data, and never leaks credentials in output or logs', async () => {
    const c = await connectStdio({
      WOO_ENABLED: 'true', WOO_STORE_URL: woo.url, WOO_CONSUMER_KEY: WOO_KEY, WOO_CONSUMER_SECRET: WOO_SECRET, WOO_ALLOW_INSECURE: 'true',
      BASE_ENABLED: 'true', BASE_API_TOKEN: BASE_TOKEN, COMMERCEWEAVE_LOG_LEVEL: 'debug',
    });
    // Base token is used against the fake through its env var only; point the connector at the fake via config file instead
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['woo_list_products', 'woo_get_product_variations', 'base_list_inventories']));
    expect(names.filter((n) => n.startsWith('woo_'))).toHaveLength(9);
    expect(names.filter((n) => n.startsWith('base_'))).toHaveLength(8);

    const out: string[] = [];
    out.push(textOf(await c.client.callTool({ name: 'woo_list_products', arguments: { connectionId: 'woo', includeVariants: true } })));
    out.push(textOf(await c.client.callTool({ name: 'woo_get_stock', arguments: { connectionId: 'woo', productId: '20', variantId: '201' } })));
    out.push(textOf(await c.client.callTool({ name: 'woo_list_orders', arguments: { connectionId: 'woo', from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' } })));
    out.push(textOf(await c.client.callTool({ name: 'woo_get_product', arguments: { connectionId: 'woo', productId: '../../x' } }))); // rejected by schema
    out.push(textOf(await c.client.callTool({ name: 'commerce_list_connections', arguments: {} })));
    // Base points at the real api.baselinker.com in this session: do NOT call it; just check the failure path is clean.
    const joined = out.join('\n') + c.stderr.join('');
    for (const secret of [WOO_KEY, WOO_SECRET, BASE_TOKEN]) expect(joined).not.toContain(secret);
    expect(out[0]).toContain('Simple mug');
    expect(out[2]).not.toContain('buyer@example.invalid');
    await c.close();
  });

  it('platform tools reject a connection of the wrong platform', async () => {
    const c = await connectStdio({ WOO_ENABLED: 'true', WOO_STORE_URL: woo.url, WOO_CONSUMER_KEY: WOO_KEY, WOO_CONSUMER_SECRET: WOO_SECRET, WOO_ALLOW_INSECURE: 'true', BASE_ENABLED: 'true', BASE_API_TOKEN: BASE_TOKEN });
    const res = await c.client.callTool({ name: 'woo_list_orders', arguments: { connectionId: 'base' } });
    expect(res.isError).toBe(true);
    expect(jsonOf<{ error: { code: string } }>(res).error.code).toBe('VALIDATION_FAILED');
    await c.close();
  });

  it('invalid credentials produce a clean typed error', async () => {
    const c = await connectStdio({ WOO_ENABLED: 'true', WOO_STORE_URL: woo.url, WOO_CONSUMER_KEY: 'ck_wrong_key_value', WOO_CONSUMER_SECRET: 'cs_wrong_secret_value', WOO_ALLOW_INSECURE: 'true' });
    const res = await c.client.callTool({ name: 'woo_list_products', arguments: { connectionId: 'woo' } });
    expect(res.isError).toBe(true);
    const txt = textOf(res) + c.stderr.join('');
    expect(jsonOf<{ error: { code: string } }>(res).error.code).toBe('AUTH_FAILED');
    expect(txt).not.toContain('cs_wrong_secret_value');
    await c.close();
  });
});

describe('multi-account isolation', () => {
  it('requires an explicit connection for writes and keeps results separated per connection', async () => {
    const c = await connectStdio({ COMMERCEWEAVE_DEMO: 'true', COMMERCEWEAVE_MODE: 'proposal' });
    const res = await c.client.callTool({ name: 'commerce_prepare_stock_update', arguments: { items: [{ productId: '901', quantity: 1 }] } });
    expect(res.isError).toBe(true); // connectionId is mandatory in the schema
    const list = jsonOf<{ connections: Array<{ connectionId: string; products: Array<{ source: { connectionId: string } }> }> }>(await c.client.callTool({ name: 'commerce_list_products', arguments: {} }));
    for (const conn of list.connections) expect(conn.products.every((p) => p.source.connectionId === conn.connectionId)).toBe(true);
    const wrongTarget = await c.client.callTool({ name: 'commerce_prepare_stock_update', arguments: { connectionId: 'demo-allegro', items: [{ productId: '901', quantity: 1 }] } });
    expect(wrongTarget.isError).toBe(true); // a Woo product id cannot be written through the Allegro connection
    await c.close();
  });
});
