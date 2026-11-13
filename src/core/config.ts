import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { CommerceError } from './errors.js';
import { registerSecret } from './redact.js';

export const ModeSchema = z.enum(['read_only', 'proposal', 'approval_required']);
export type Mode = z.infer<typeof ModeSchema>;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'connection id: lowercase letters, digits, - and _ (max 32)');
const accessSchema = z.enum(['read_only', 'read_write']).optional();
const statusMapSchema = z.record(z.string(), z.enum(['unpaid', 'open', 'fulfilled', 'cancelled', 'refunded'])).optional();

export const AllegroConnSchema = z.object({
  platform: z.literal('allegro'),
  id: idSchema,
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  access: accessSchema,
  statusMap: statusMapSchema,
  /** Test/advanced override of API and auth hosts. */
  apiUrl: z.url().optional(),
  authUrl: z.url().optional(),
});
export const BaseConnSchema = z.object({
  platform: z.literal('baselinker'),
  id: idSchema,
  token: z.string().min(8),
  access: accessSchema,
  /** Restrict to these catalog ids; default = all catalogs. */
  inventoryIds: z.array(z.string()).optional(),
  statusMap: statusMapSchema,
  apiUrl: z.url().optional(),
});
export const WooConnSchema = z.object({
  platform: z.literal('woocommerce'),
  id: idSchema,
  storeUrl: z.url(),
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
  access: accessSchema,
  /** Allow http:// and private hosts. Only for local development stores. */
  allowInsecure: z.boolean().default(false),
  currency: z.string().length(3).optional(),
});
export const ConnSchema = z.discriminatedUnion('platform', [AllegroConnSchema, BaseConnSchema, WooConnSchema]);
export type ConnectionConfig = z.infer<typeof ConnSchema>;
export type AllegroConfig = z.infer<typeof AllegroConnSchema>;
export type BaseConfig = z.infer<typeof BaseConnSchema>;
export type WooConfig = z.infer<typeof WooConnSchema>;

/** Optional explicit cross-platform product mapping: each group lists the same product on several connections. */
export const SkuMapSchema = z.array(
  z.object({ label: z.string().optional(), members: z.array(z.object({ connectionId: z.string(), productId: z.string(), variantId: z.string().optional() })).min(2) }),
);

export interface Settings {
  mode: Mode;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  demo: boolean;
  home: string;
  tokenKey?: string;
  timezone: string;
  approvalTtlMs: number;
  connections: ConnectionConfig[];
  skuMap: z.infer<typeof SkuMapSchema>;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

function resolveRef(v: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof v === 'string' && v.startsWith('env:')) {
    const name = v.slice(4);
    const val = env[name];
    if (!val) throw new CommerceError('CONFIG_INVALID', `Environment variable ${name} (referenced in config file) is not set`);
    return val;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRef(x, env));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRef(x, env)]));
  return v;
}

function collectSecrets(c: ConnectionConfig) {
  if (c.platform === 'allegro') { registerSecret(c.clientSecret); registerSecret(c.clientId); }
  if (c.platform === 'baselinker') registerSecret(c.token);
  if (c.platform === 'woocommerce') { registerSecret(c.consumerKey); registerSecret(c.consumerSecret); }
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const modeParsed = ModeSchema.safeParse(env.COMMERCEWEAVE_MODE ?? 'read_only');
  if (!modeParsed.success) {
    throw new CommerceError('CONFIG_INVALID', `COMMERCEWEAVE_MODE must be one of read_only | proposal | approval_required (got "${env.COMMERCEWEAVE_MODE}")`);
  }
  const rawConns: unknown[] = [];
  let skuMap: Settings['skuMap'] = [];

  if (truthy(env.ALLEGRO_ENABLED)) {
    rawConns.push({ platform: 'allegro', id: env.ALLEGRO_CONNECTION_ID ?? 'allegro', environment: env.ALLEGRO_ENVIRONMENT ?? 'sandbox', clientId: env.ALLEGRO_CLIENT_ID, clientSecret: env.ALLEGRO_CLIENT_SECRET, access: env.ALLEGRO_ACCESS || undefined });
  }
  if (truthy(env.BASE_ENABLED)) {
    rawConns.push({ platform: 'baselinker', id: env.BASE_CONNECTION_ID ?? 'base', token: env.BASE_API_TOKEN, access: env.BASE_ACCESS || undefined, inventoryIds: env.BASE_INVENTORY_IDS ? env.BASE_INVENTORY_IDS.split(',').map((s) => s.trim()) : undefined });
  }
  if (truthy(env.WOO_ENABLED)) {
    rawConns.push({ platform: 'woocommerce', id: env.WOO_CONNECTION_ID ?? 'woo', storeUrl: env.WOO_STORE_URL, consumerKey: env.WOO_CONSUMER_KEY, consumerSecret: env.WOO_CONSUMER_SECRET, access: env.WOO_ACCESS || undefined, allowInsecure: truthy(env.WOO_ALLOW_INSECURE) });
  }
  if (env.COMMERCEWEAVE_CONFIG) {
    const path = resolve(env.COMMERCEWEAVE_CONFIG);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new CommerceError('CONFIG_INVALID', `Cannot read COMMERCEWEAVE_CONFIG (${path}): ${(e as Error).message}`);
    }
    const resolved = resolveRef(json, env) as { connections?: unknown[]; skuMap?: unknown };
    rawConns.push(...(resolved.connections ?? []));
    if (resolved.skuMap) skuMap = SkuMapSchema.parse(resolved.skuMap);
  }

  const connections: ConnectionConfig[] = [];
  for (const raw of rawConns) {
    const p = ConnSchema.safeParse(raw);
    if (!p.success) {
      const id = (raw as { id?: string }).id ?? '?';
      const issues = p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new CommerceError('CONFIG_INVALID', `Invalid configuration for connection "${id}": ${issues}`);
    }
    connections.push(p.data);
    collectSecrets(p.data);
  }
  const ids = new Set<string>();
  for (const c of connections) {
    if (ids.has(c.id)) throw new CommerceError('CONFIG_INVALID', `Duplicate connection id "${c.id}"`);
    ids.add(c.id);
  }
  for (const c of connections) {
    if (c.platform === 'woocommerce' && !c.allowInsecure) assertSafeWooUrl(c.storeUrl);
  }
  const key = env.COMMERCEWEAVE_TOKEN_KEY;
  registerSecret(key);
  return {
    mode: modeParsed.data,
    logLevel: (['debug', 'info', 'warn', 'error'] as const).find((l) => l === env.COMMERCEWEAVE_LOG_LEVEL) ?? 'info',
    demo: truthy(env.COMMERCEWEAVE_DEMO),
    home: env.COMMERCEWEAVE_HOME ? resolve(env.COMMERCEWEAVE_HOME) : join(homedir(), '.commerceweave'),
    tokenKey: key || undefined,
    timezone: env.COMMERCEWEAVE_TIMEZONE ?? 'Europe/Warsaw',
    approvalTtlMs: Math.min(Math.max(Number(env.COMMERCEWEAVE_APPROVAL_TTL_MIN ?? 15), 1), 240) * 60_000,
    connections,
    skuMap,
  };
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/** SSRF guard for the one user-supplied URL: production Woo stores must be public HTTPS. */
export function assertSafeWooUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new CommerceError('CONFIG_INVALID', 'WooCommerce store URL must use https:// (set allowInsecure only for local development stores)');
  if (u.username || u.password) throw new CommerceError('CONFIG_INVALID', 'WooCommerce store URL must not contain credentials');
  if (PRIVATE_HOST.test(u.hostname)) throw new CommerceError('CONFIG_INVALID', `WooCommerce store URL points to a private/loopback host (${u.hostname}); set allowInsecure only for local development stores`);
}

export function isWritable(c: ConnectionConfig, mode: Mode): boolean {
  return mode !== 'read_only' && c.access !== 'read_only';
}
