import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIST, jsonOf, tmpHome } from '../helpers/mcp.js';

const TOKEN = 'a'.repeat(16) + 'B'.repeat(16) + '1234';

function baseEnv(extra: Record<string, string> = {}) {
  return { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', COMMERCEWEAVE_HOME: tmpHome(), COMMERCEWEAVE_DEMO: 'true', COMMERCEWEAVE_HTTP_PORT: '0', ...extra };
}

describe('Streamable HTTP transport', () => {
  let proc: ChildProcess;
  let url = '';
  const logs: string[] = [];

  beforeAll(async () => {
    proc = spawn(process.execPath, [DIST, 'serve-http'], { env: baseEnv({ COMMERCEWEAVE_HTTP_TOKEN: TOKEN, COMMERCEWEAVE_MODE: 'approval_required' }), stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr?.on('data', (d: Buffer) => logs.push(String(d)));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start: ' + logs.join(''))), 15_000);
      const check = () => {
        const m = /listening on (http:\/\/[^\s]+\/mcp)/.exec(logs.join(''));
        if (m) { url = m[1] as string; clearTimeout(t); resolve(); }
      };
      proc.stderr?.on('data', check);
    });
  });
  afterAll(() => { proc.kill(); });

  const post = (headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'ping' }) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

  it('binds loopback only and never prints the token', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(logs.join('')).not.toContain(TOKEN);
  });

  it('rejects requests without a token or with a wrong token (401)', async () => {
    expect((await post({})).status).toBe(401);
    const wrong = await post({ Authorization: 'Bearer ' + 'x'.repeat(36) });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await post({ Authorization: 'Basic ' + TOKEN })).status).toBe(401);
  });

  it('rejects a foreign Host header (DNS rebinding) and a foreign Origin (403) even with a valid token', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const origin = await post({ ...auth, Origin: 'https://evil.example' });
    expect(origin.status).toBe(403);
    const res = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const u = new URL(url);
        const r = request({ host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', ...auth, 'Content-Type': 'application/json' } }, (resp) => { resp.resume(); resolve(resp.statusCode ?? 0); });
        r.on('error', reject);
        r.end('{}');
      }, reject);
    });
    expect(res).toBe(403);
  });

  it('only serves /mcp', async () => {
    const r = await fetch(url.replace('/mcp', '/other'), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(404);
  });

  it('throttles repeated failed authentication', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await post({ Authorization: 'Bearer nope' + i })).status);
    expect(codes).toContain(429);
  });

  it('a valid token gets a full MCP session; writes still cannot be approved over HTTP', async () => {
    // a valid token still works right after a burst of failures (no lock-out of the owner)
    const client = new Client({ name: 'http-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    expect(client.getServerVersion()?.name).toBe('commerceweave-mcp');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('commerce_execute_proposal');
    expect(names.some((n) => /approve|grant|confirm/i.test(n))).toBe(false);
    const conns = jsonOf<{ connections: Array<{ connectionId: string }> }>(await client.callTool({ name: 'commerce_list_connections', arguments: {} }));
    expect(conns.connections).toHaveLength(3);
    const prep = jsonOf<{ proposalId: string }>(await client.callTool({ name: 'commerce_prepare_stock_update', arguments: { connectionId: 'demo-woo', items: [{ productId: '901', quantity: 3 }] } }));
    const exec = await client.callTool({ name: 'commerce_execute_proposal', arguments: { proposalId: prep.proposalId } });
    expect(exec.isError).toBe(true);
    expect(jsonOf<{ error: { code: string } }>(exec).error.code).toBe('APPROVAL_REQUIRED');
    await client.close();
  });
});

describe('HTTP transport refuses unsafe configuration', () => {
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, [DIST, 'serve-http'], { env: baseEnv(extra), encoding: 'utf8', timeout: 15_000 });

  it('does not start without a strong token', () => {
    for (const t of [undefined, 'short']) {
      const r = run(t ? { COMMERCEWEAVE_HTTP_TOKEN: t } : {});
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/COMMERCEWEAVE_HTTP_TOKEN/);
      expect(r.stderr).not.toContain('short');
    }
  });
  it('does not bind a non-loopback address without explicit opt-in and allowed hosts', () => {
    const a = run({ COMMERCEWEAVE_HTTP_TOKEN: TOKEN, COMMERCEWEAVE_HTTP_HOST: '0.0.0.0' });
    expect(a.status).toBe(1);
    expect(a.stderr).toMatch(/loopback/);
    const b = run({ COMMERCEWEAVE_HTTP_TOKEN: TOKEN, COMMERCEWEAVE_HTTP_HOST: '0.0.0.0', COMMERCEWEAVE_HTTP_ALLOW_REMOTE: 'true' });
    expect(b.status).toBe(1);
    expect(b.stderr).toMatch(/ALLOWED_HOSTS/);
  });
});
