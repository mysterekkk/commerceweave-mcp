import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Registry } from '../connectors/registry.js';
import type { Settings } from '../core/config.js';
import { CommerceError } from '../core/errors.js';
import { log } from '../core/logging.js';
import { registerSecret } from '../core/redact.js';
import { createServer as createMcpServer, SERVER_NAME, SERVER_VERSION } from './create-server.js';

export interface HttpOptions {
  host: string;
  port: number;
  token: string;
  allowRemote: boolean;
  /** Hostnames accepted in the Host header (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Origins accepted for browser clients. Non-browser clients send none. */
  allowedOrigins: string[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_FAILURES_PER_MINUTE = 10;

export function loadHttpOptions(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const host = env.COMMERCEWEAVE_HTTP_HOST ?? '127.0.0.1';
  const port = Number(env.COMMERCEWEAVE_HTTP_PORT ?? 8787);
  const token = env.COMMERCEWEAVE_HTTP_TOKEN ?? '';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CommerceError('CONFIG_INVALID', 'COMMERCEWEAVE_HTTP_PORT must be 0..65535');
  if (token.length < 32) {
    throw new CommerceError('CONFIG_INVALID', 'The HTTP transport requires COMMERCEWEAVE_HTTP_TOKEN (at least 32 characters, e.g. `openssl rand -hex 32`). It is never started without authentication.');
  }
  const allowRemote = /^(1|true|yes|on)$/i.test(env.COMMERCEWEAVE_HTTP_ALLOW_REMOTE ?? '');
  const loopback = LOOPBACK.has(host);
  if (!loopback && !allowRemote) {
    throw new CommerceError('CONFIG_INVALID', `Refusing to bind ${host}: only loopback is allowed unless COMMERCEWEAVE_HTTP_ALLOW_REMOTE=true. If you expose it, put it behind a TLS-terminating reverse proxy.`);
  }
  const extraHosts = (env.COMMERCEWEAVE_HTTP_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!loopback && extraHosts.length === 0) {
    throw new CommerceError('CONFIG_INVALID', 'A non-loopback bind needs COMMERCEWEAVE_HTTP_ALLOWED_HOSTS (comma-separated Host header names) for DNS-rebinding protection.');
  }
  const origins = (env.COMMERCEWEAVE_HTTP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  registerSecret(token);
  return {
    host, port, token, allowRemote,
    allowedHosts: [...new Set(['localhost', '127.0.0.1', '[::1]', ...extraHosts])],
    allowedOrigins: origins.length ? origins : ['localhost', '127.0.0.1', '[::1]'],
  };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

function deny(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify({ error: message }));
}

export interface RunningHttp {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/**
 * Streamable HTTP endpoint at /mcp. Every request must carry `Authorization: Bearer <token>`.
 * Approval of writes is NOT possible over this transport: it stays a human action in a terminal.
 */
export async function startHttp(settings: Settings, opts: HttpOptions, reg?: Registry): Promise<RunningHttp> {
  const handler = createMcpHandler(() => createMcpServer(settings, reg), { onerror: (e: Error) => log('warn', `http handler error: ${e.message}`) });
  const nodeHandler = toNodeHandler(handler);
  const checkHost = hostHeaderValidation(opts.allowedHosts);
  const checkOrigin = originValidation(opts.allowedOrigins);
  const expected = digest(opts.token);
  const failures = new Map<string, { count: number; since: number }>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Order matters: cheap structural checks first, then authentication, then the MCP handler.
    if (!checkHost(req, res)) return;
    if (!checkOrigin(req, res)) return;
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/mcp') return deny(res, 404, 'not found');

    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const header = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    const ok = !!m && timingSafeEqual(digest(m[1] as string), expected);
    if (!ok) {
      // Only WRONG credentials are throttled, so an attacker can never lock the legitimate client out.
      const f = failures.get(ip);
      const cur = f && now - f.since < 60_000 ? f : { count: 0, since: now };
      cur.count++;
      failures.set(ip, cur);
      if (cur.count > MAX_FAILURES_PER_MINUTE) return deny(res, 429, 'too many failed authentication attempts', { 'Retry-After': '60' });
      return deny(res, 401, 'missing or invalid bearer token', { 'WWW-Authenticate': 'Bearer realm="commerceweave-mcp"' });
    }
    failures.delete(ip);
    void nodeHandler(req, res);
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });
  const addr = server.address() as AddressInfo;
  const shownHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  const url = `http://${shownHost}:${addr.port}/mcp`;
  log('info', `${SERVER_NAME} ${SERVER_VERSION} listening on ${url} (mode=${settings.mode}${settings.demo ? ', DEMO' : ''}; bearer token required)`);
  if (!LOOPBACK.has(opts.host)) log('warn', 'Bound to a non-loopback address over plain HTTP. Terminate TLS in front of it; the bearer token is otherwise sent in clear text.');
  return {
    server, url,
    close: async () => {
      await handler.close();
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    },
  };
}
