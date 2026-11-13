import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connectStdio } from '../helpers/mcp.js';

const ALL = {
  ALLEGRO_ENABLED: 'true', ALLEGRO_CLIENT_ID: 'cid-test', ALLEGRO_CLIENT_SECRET: 'csecret-test',
  BASE_ENABLED: 'true', BASE_API_TOKEN: '1-23-TOKENTOKEN',
  WOO_ENABLED: 'true', WOO_STORE_URL: 'https://shop.example.com', WOO_CONSUMER_KEY: 'ck_x', WOO_CONSUMER_SECRET: 'cs_x',
};

async function names(env: Record<string, string>) {
  const c = await connectStdio(env);
  const n = (await c.client.listTools()).tools.map((t) => t.name);
  await c.close();
  return n;
}

describe('tool surface per mode (documented counts)', () => {
  it('read_only, all three platforms: 9 unified + 26 platform = 35, all read-only', async () => {
    const n = await names(ALL);
    expect(n).toHaveLength(35);
    expect(n.filter((x) => x.startsWith('allegro_'))).toHaveLength(9);
    expect(n.filter((x) => x.startsWith('base_'))).toHaveLength(8);
    expect(n.filter((x) => x.startsWith('woo_'))).toHaveLength(9);
    expect(n.filter((x) => x.startsWith('commerce_'))).toHaveLength(9);
  });
  it('proposal: 42, approval_required: 43, demo read_only: 9', async () => {
    expect(await names({ ...ALL, COMMERCEWEAVE_MODE: 'proposal' })).toHaveLength(42);
    expect(await names({ ...ALL, COMMERCEWEAVE_MODE: 'approval_required' })).toHaveLength(43);
    expect(await names({ COMMERCEWEAVE_DEMO: 'true' })).toHaveLength(9);
  });
  it('every tool is described in docs/tools.md and no documented tool is missing', async () => {
    const n = await names({ ...ALL, COMMERCEWEAVE_MODE: 'approval_required' });
    const doc = readFileSync(new URL('../../docs/tools.md', import.meta.url), 'utf8');
    for (const t of n) expect(doc, t).toContain('`' + t + '`');
    const documented = [...doc.matchAll(/`((?:commerce|allegro|base|woo)_[a-z_]+)`/g)].map((m) => m[1] as string).filter((t) => !t.startsWith('woo_update') && !t.startsWith('allegro_update') && t !== 'woo_create_product_draft');
    for (const t of new Set(documented)) expect(n, t).toContain(t);
  });
});
