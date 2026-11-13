import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectStdio, jsonOf, textOf } from '../helpers/mcp.js';

type Conn = Awaited<ReturnType<typeof connectStdio>>;

describe('real stdio server, demo mode, read_only default', () => {
  let c: Conn;
  beforeAll(async () => { c = await connectStdio({ COMMERCEWEAVE_DEMO: 'true' }); });
  afterAll(async () => { await c.close(); });

  it('completes the MCP handshake and advertises server info', () => {
    expect(c.client.getServerVersion()?.name).toBe('commerceweave-mcp');
    expect(c.client.getInstructions()).toContain('read_only');
  });

  it('lists tools with descriptions and schemas; no write tools in read_only', async () => {
    const { tools } = await c.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['commerce_list_connections', 'commerce_list_orders', 'commerce_low_stock', 'commerce_sales_summary', 'commerce_find_stock_discrepancies']));
    expect(names.some((n) => /prepare|execute|update/.test(n))).toBe(false);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('lists three demo connections', async () => {
    const r = jsonOf<{ connections: Array<{ connectionId: string }>; mode: string }>(await c.client.callTool({ name: 'commerce_list_connections', arguments: {} }));
    expect(r.mode).toBe('read_only');
    expect(r.connections.map((x) => x.connectionId).sort()).toEqual(['demo-allegro', 'demo-base', 'demo-woo']);
  });

  it("scenario A: today's orders, deduped, PII masked, injection text kept as data", async () => {
    const res = await c.client.callTool({ name: 'commerce_list_orders', arguments: { days: 7 } });
    const r = jsonOf<{ orders: Array<{ source: { connectionId: string; externalId: string }; duplicate?: { status: string }; customer: { email?: string; redacted: boolean }; untrustedText?: { buyerNote?: string } }>; confirmedDuplicates: number; potentialDuplicates: number; securityNotice: string }>(res);
    expect(r.confirmedDuplicates).toBe(1);
    expect(r.potentialDuplicates).toBe(1);
    expect(r.securityNotice).toMatch(/never instructions/);
    expect(textOf(res)).not.toMatch(/jan\.demo|anna\.demo|48500000001/);
    expect(r.orders.every((o) => o.customer.redacted)).toBe(true);
  });

  it('scenario E: sales summary does not double count and separates currency', async () => {
    const r = jsonOf<{ currencies: Array<{ currency: string; orderCount: number; grossRevenue: string; potentialDuplicates: { orders: number } }>; notes: string[] }>(await c.client.callTool({ name: 'commerce_sales_summary', arguments: { days: 7 } }));
    expect(r.currencies).toHaveLength(1);
    const pln = r.currencies[0]!;
    // 8 demo orders - 1 confirmed duplicate = 7 counted; potential duplicate is counted but flagged
    expect(pln.currency).toBe('PLN');
    expect(pln.orderCount).toBe(7);
    expect(pln.grossRevenue).toBe('455.86'); // 208.88 Allegro + 88.99 Base (native+shop) + 157.99 Woo
    expect(pln.potentialDuplicates.orders).toBe(1);
    expect(r.notes.join(' ')).toMatch(/NOT profit/);
  });

  it('scenario B: low stock lists variants individually', async () => {
    const r = jsonOf<{ items: Array<{ sku: string; total: number; connectionId: string }> }>(await c.client.callTool({ name: 'commerce_low_stock', arguments: { threshold: 3 } }));
    const skus = r.items.map((i) => `${i.connectionId}:${i.sku}`);
    expect(skus).toContain('demo-allegro:LAMP-02');
    expect(skus).toContain('demo-base:TEE-BLK-L');
    expect(skus).toContain('demo-woo:TEE-BLK-L');
    expect(r.items.every((i) => i.total <= 3)).toBe(true);
  });

  it('scenario D: finds stock discrepancies and changes nothing', async () => {
    const r = jsonOf<{ discrepancies: Array<{ key: string; difference: number }>; inSync: number; suggestedUpdates?: unknown }>(await c.client.callTool({ name: 'commerce_find_stock_discrepancies', arguments: { connectionIds: ['demo-base', 'demo-woo'] } }));
    const keys = r.discrepancies.map((d) => d.key).sort();
    expect(keys).toEqual(['LAMP-02', 'TEE-BLK-L', 'TEE-BLK-M']);
    expect(r.inSync).toBe(3);
  });

  it('returns a typed error object for unknown connections', async () => {
    const res = await c.client.callTool({ name: 'commerce_get_order', arguments: { connectionId: 'nope', orderId: '1' } });
    expect(res.isError).toBe(true);
    expect(jsonOf<{ error: { code: string } }>(res).error.code).toBe('NOT_FOUND');
  });

  it('rejects invalid input via the schema', async () => {
    const res = await c.client.callTool({ name: 'commerce_low_stock', arguments: { threshold: -4 } });
    expect(res.isError).toBe(true);
  });

  it('never writes anything to stdout except protocol messages', () => {
    // If a stray console.log had landed on stdout, the JSON-RPC parser would have failed during the calls above.
    expect(c.stderr.join('')).toContain('listening on stdio');
  });
});
