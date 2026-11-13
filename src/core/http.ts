import { randomUUID } from 'node:crypto';
import { CommerceError } from './errors.js';
import type { RateLimiter } from './rate-limiter.js';
import { maskString } from './redact.js';

export interface HttpOptions {
  connectionId: string;
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  limiter?: RateLimiter;
  /** Runs before every request attempt. */
  beforeRequest?: () => Promise<void>;
  /** undici dispatcher (e.g. DNS-pinned agent). */
  dispatcher?: unknown;
  defaultHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | Array<string | number>>;
  body?: string | URLSearchParams;
  headers?: Record<string, string>;
  /** Only idempotent reads are retried automatically. Writes never are. */
  idempotent?: boolean;
  signal?: AbortSignal;
  contentType?: string;
}

export interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base / 2 + Math.random() * (base / 2);
}

export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(n * 1000, 120_000);
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.min(Math.max(d - Date.now(), 0), 120_000);
}

function httpError(status: number, data: unknown, headers: Headers, connectionId: string, correlationId: string, method: string): CommerceError {
  const msg = maskString(typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 500));
  const d = { connectionId, status, correlationId };
  if (status === 401) return new CommerceError('AUTH_FAILED', `Authentication failed (401): ${msg}`, d);
  if (status === 403) return new CommerceError('PERMISSION_DENIED', `Permission denied (403): ${msg}`, d);
  if (status === 404) return new CommerceError('NOT_FOUND', `Not found (404): ${msg}`, d);
  if (status === 429) {
    return new CommerceError('RATE_LIMITED', `Rate limited (429): ${msg}`, { ...d, retryAfterMs: parseRetryAfter(headers.get('retry-after')) });
  }
  if (status === 400 || status === 409 || status === 422) {
    return new CommerceError('VALIDATION_FAILED', `Rejected by platform (${status}): ${msg}`, d);
  }
  if (status >= 500) {
    return method === 'GET'
      ? new CommerceError('SERVER_ERROR', `Platform server error (${status}): ${msg}`, d)
      : new CommerceError('WRITE_OUTCOME_UNKNOWN', `Platform server error (${status}) during ${method}; the change may or may not have been applied.`, d);
  }
  return new CommerceError('UPSTREAM_ERROR', `Unexpected status ${status}: ${msg}`, d);
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: HttpOptions) {
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.maxRetries = o.maxRetries ?? 3;
    this.sleep = o.sleep ?? sleepDefault;
  }

  buildUrl(path: string, query?: RequestOptions['query']): string {
    if (path.split('/').some((seg) => seg === '.' || seg === '..' || /^%2e/i.test(seg))) throw new CommerceError('VALIDATION_FAILED', 'Path traversal segments are not allowed');
    // An empty path means "the base URL itself" (e.g. Base's connector.php); otherwise resolve relative to a directory.
    const u = path === '' ? new URL(this.o.baseUrl) : new URL(path.replace(/^\//, ''), this.o.baseUrl.endsWith('/') ? this.o.baseUrl : this.o.baseUrl + '/');
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T = unknown>(r: RequestOptions): Promise<HttpResult<T>> {
    const method = r.method ?? 'GET';
    const retryable = r.idempotent ?? method === 'GET';
    const correlationId = randomUUID().slice(0, 8);
    const connectionId = this.o.connectionId;
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.o.limiter?.acquire(r.signal);
      await this.o.beforeRequest?.();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.timeoutMs);
      const onAbort = () => ctrl.abort(r.signal?.reason);
      r.signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response;
      try {
        const base = (await this.o.defaultHeaders?.()) ?? {};
        const headers: Record<string, string> = { ...base, ...(r.headers ?? {}) };
        if (r.body && r.contentType) headers['Content-Type'] = r.contentType;
        res = await fetch(this.buildUrl(r.path, r.query), {
          method,
          headers,
          body: r.body as BodyInit | undefined,
          signal: ctrl.signal,
          redirect: 'error',
          ...(this.o.dispatcher ? { dispatcher: this.o.dispatcher } : {}),
        } as RequestInit);
      } catch (e) {
        clearTimeout(timer);
        r.signal?.removeEventListener('abort', onAbort);
        const timedOut = (ctrl.signal.reason as Error | undefined)?.message === 'timeout';
        if (r.signal?.aborted) throw new CommerceError('NETWORK_ERROR', 'Request cancelled', { connectionId, correlationId });
        if (retryable && attempt <= this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        if (method !== 'GET' && !retryable) {
          throw new CommerceError(
            'WRITE_OUTCOME_UNKNOWN',
            `${timedOut ? 'Timeout' : 'Network error'} during ${method}; the change may or may not have been applied. Re-read the current state before retrying.`,
            { connectionId, correlationId },
          );
        }
        const msg = timedOut ? `Request timed out after ${this.timeoutMs}ms` : `Network error: ${(e as Error).message}`;
        throw new CommerceError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', maskString(msg), { connectionId, correlationId });
      }
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onAbort);

      if ((res.status === 429 || res.status >= 500) && retryable && attempt <= this.maxRetries) {
        const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoff(attempt);
        if (res.status === 429) this.o.limiter?.penalize(wait);
        await res.arrayBuffer().catch(() => undefined);
        await this.sleep(wait);
        continue;
      }
      const text = await res.text();
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          /* keep raw text */
        }
      }
      if (!res.ok) throw httpError(res.status, data, res.headers, connectionId, correlationId, method);
      return { status: res.status, headers: res.headers, data: data as T };
    }
  }
}
