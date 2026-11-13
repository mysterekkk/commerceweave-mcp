import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createPinnedAgent } from '../../src/core/host-guard.js';

describe('DNS-pinned agent', () => {
  it('refuses to connect to a hostname that resolves to loopback (rebinding / internal target)', async () => {
    const srv = createServer((_q, r) => r.end('internal secret'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const agent = createPinnedAgent();
    const res = await fetch(`http://localhost:${port}/`, { dispatcher: agent } as RequestInit).then(() => 'connected', (e: Error) => String(e.cause ?? e));
    srv.close();
    expect(res).not.toBe('connected');
    expect(res).toMatch(/non-public address/);
  });
});
