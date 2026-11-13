import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/core/config.js';
import { CommerceError } from '../../src/core/errors.js';
import { assertPublicHostname, isBlockedIp } from '../../src/core/host-guard.js';
import { HttpClient } from '../../src/core/http.js';
import { applyPercent, formatDecimal, normalizeMoney, parseDecimal, roundDecimal } from '../../src/core/money.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { clearSecretsForTests, maskDeep, maskString, registerSecret } from '../../src/core/redact.js';
import { addDaysYmd, resolveRange, startOfDayUtc } from '../../src/core/time.js';
import { TokenStore } from '../../src/core/token-store.js';
import { markDuplicates } from '../../src/unified/dedupe.js';
import type { CommerceOrder } from '../../src/core/models.js';
import { tmpHome } from '../helpers/mcp.js';

describe('money: exact decimals', () => {
  it('never shows float artefacts', () => {
    expect(formatDecimal(parseDecimal('0.1') + parseDecimal('0.2'))).toBe('0.30');
    expect(normalizeMoney(19.99)).toBe('19.99');
    expect(normalizeMoney('1234567.891')).toBe('1234567.89');
  });
  it('rounds half away from zero', () => {
    expect(formatDecimal(applyPercent(parseDecimal('39.90'), '5'))).toBe('41.90'); // 41.895
    expect(formatDecimal(applyPercent(parseDecimal('0.05'), '10'))).toBe('0.06');  // 0.055
    expect(formatDecimal(roundDecimal(parseDecimal('-2.675'), 2))).toBe('-2.68');
  });
  it('percent on large amounts stays exact', () => {
    expect(formatDecimal(applyPercent(parseDecimal('999999.99'), '3.3333'))).toBe('1033332.99');
  });
  it('rejects garbage', () => {
    for (const bad of ['', 'abc', '1,5', '1e3', '--1', '1.2.3']) expect(() => parseDecimal(bad)).toThrow(CommerceError);
    expect(() => parseDecimal(Number.NaN)).toThrow();
  });
});

describe('time: local day boundaries', () => {
  it('Warsaw midnight is 23:00Z in winter and 22:00Z in summer', () => {
    expect(startOfDayUtc('2026-11-13', 'Europe/Warsaw').toISOString()).toBe('2026-11-12T23:00:00.000Z');
    expect(startOfDayUtc('2026-07-01', 'Europe/Warsaw').toISOString()).toBe('2026-06-30T22:00:00.000Z');
  });
  it('a full day is 23h on the spring DST change', () => {
    const a = startOfDayUtc('2026-03-29', 'Europe/Warsaw').getTime();
    const b = startOfDayUtc('2026-03-30', 'Europe/Warsaw').getTime();
    expect((b - a) / 3_600_000).toBe(23);
  });
  it('resolves "today" and "last N days" in the given timezone', () => {
    const now = new Date('2026-11-13T23:30:00Z'); // 00:30 on Nov 14 in Warsaw
    expect(resolveRange({ timezone: 'Europe/Warsaw' }, now).from.toISOString()).toBe('2026-11-13T23:00:00.000Z');
    expect(resolveRange({ days: 7, timezone: 'Europe/Warsaw' }, now).from.toISOString()).toBe('2026-11-07T23:00:00.000Z');
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('rejects bad timezones and ranges', () => {
    expect(() => resolveRange({ timezone: 'Mars/Olympus' })).toThrow(/timezone/);
    expect(() => resolveRange({ from: '2026-02-01', to: '2026-01-01', timezone: 'UTC' })).toThrow();
  });
});

describe('rate limiter', () => {
  it('allows max N per window and then waits for the window to slide', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(3, 1000, () => now, async (ms) => { sleeps.push(ms); now += ms; });
    for (let i = 0; i < 3; i++) await rl.acquire();
    expect(sleeps).toHaveLength(0);
    await rl.acquire();
    expect(sleeps).toEqual([1000]);
  });
  it('penalize pushes the next acquisition out', async () => {
    let now = 0; const sleeps: number[] = [];
    const rl = new RateLimiter(1, 1000, () => now, async (ms) => { sleeps.push(ms); now += ms; });
    rl.penalize(5000);
    await rl.acquire();
    expect(sleeps[0]).toBeGreaterThanOrEqual(5000);
  });
});

describe('http client', () => {
  it('rejects path traversal segments', () => {
    const h = new HttpClient({ connectionId: 'x', baseUrl: 'https://example.com/api/' });
    expect(() => h.buildUrl('products/../../admin')).toThrow(/traversal/);
    expect(() => h.buildUrl('products/%2e%2e/x')).toThrow(/traversal/);
    expect(h.buildUrl('products/12', { a: 1, b: undefined, c: ['x', 'y'] })).toBe('https://example.com/api/products/12?a=1&c=x&c=y');
  });
  it('an empty path resolves to the base URL itself', () => {
    expect(new HttpClient({ connectionId: 'x', baseUrl: 'https://api.baselinker.com/connector.php' }).buildUrl('')).toBe('https://api.baselinker.com/connector.php');
  });
});

describe('SSRF host guard', () => {
  it('blocks private, loopback, link-local, CGNAT and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) expect(isBlockedIp(ip), ip).toBe(false);
  });
  it('normalised IP spellings are caught through URL parsing', () => {
    for (const u of ['https://2130706433/', 'https://0x7f.1/', 'https://017700000001/', 'https://[::1]/', 'https://localhost/', 'https://shop.internal/']) {
      expect(() => assertPublicHostname(new URL(u).hostname), u).toThrow(CommerceError);
    }
  });
});

describe('redaction', () => {
  it('masks registered secrets, bearer tokens and secret-named keys everywhere', () => {
    clearSecretsForTests();
    registerSecret('SuperSecretValue123');
    expect(maskString('failed with SuperSecretValue123 in text')).not.toContain('SuperSecretValue123');
    expect(maskString('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer [REDACTED]');
    expect(maskString('https://x/?consumer_key=ck_abc&consumer_secret=cs_def&page=1')).toBe('https://x/?consumer_key=[REDACTED]&consumer_secret=[REDACTED]&page=1');
    expect(maskDeep({ ok: 1, nested: { api_token: 'x', note: 'SuperSecretValue123' } })).toEqual({ ok: 1, nested: { api_token: '[REDACTED]', note: '[REDACTED]' } });
    clearSecretsForTests();
  });
});

describe('config', () => {
  const base = { COMMERCEWEAVE_HOME: '/tmp/cw-x' };
  it('defaults to read_only with no connections', () => {
    const s = loadSettings({ ...base });
    expect(s.mode).toBe('read_only');
    expect(s.connections).toEqual([]);
    expect(s.demo).toBe(false);
  });
  it('rejects an unknown mode and incomplete connections without echoing secrets', () => {
    expect(() => loadSettings({ ...base, COMMERCEWEAVE_MODE: 'yolo' })).toThrow(/read_only \| proposal/);
    try {
      loadSettings({ ...base, BASE_ENABLED: 'true', BASE_API_TOKEN: 'short' });
      expect.unreachable();
    } catch (e) { expect((e as Error).message).not.toContain('short'); }
    expect(() => loadSettings({ ...base, ALLEGRO_ENABLED: 'true' })).toThrow(/clientId/);
  });
  it('rejects http and private Woo URLs; allows them only with explicit opt-in', () => {
    const w = { ...base, WOO_ENABLED: 'true', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's' };
    expect(() => loadSettings({ ...w, WOO_STORE_URL: 'http://shop.example.com' })).toThrow(/https/);
    expect(() => loadSettings({ ...w, WOO_STORE_URL: 'https://192.168.0.5' })).toThrow(/private/);
    expect(loadSettings({ ...w, WOO_STORE_URL: 'http://localhost:8080', WOO_ALLOW_INSECURE: 'true' }).connections).toHaveLength(1);
  });
  it('supports several accounts from a config file with env references and rejects duplicate ids', () => {
    const dir = tmpHome();
    const f = join(dir, 'cfg.json');
    writeFileSync(f, JSON.stringify({ connections: [
      { platform: 'baselinker', id: 'base-a', token: 'env:TOK_A' }, { platform: 'baselinker', id: 'base-b', token: 'env:TOK_B' },
      { platform: 'woocommerce', id: 'shop-1', storeUrl: 'https://one.example.com', consumerKey: 'env:K', consumerSecret: 'env:S' },
    ] }));
    const s = loadSettings({ COMMERCEWEAVE_HOME: dir, COMMERCEWEAVE_CONFIG: f, TOK_A: 'aaaaaaaa11', TOK_B: 'bbbbbbbb22', K: 'ck', S: 'cs' });
    expect(s.connections.map((c) => c.id)).toEqual(['base-a', 'base-b', 'shop-1']);
    writeFileSync(f, JSON.stringify({ connections: [{ platform: 'baselinker', id: 'x', token: 'aaaaaaaa11' }, { platform: 'baselinker', id: 'x', token: 'bbbbbbbb22' }] }));
    expect(() => loadSettings({ COMMERCEWEAVE_HOME: dir, COMMERCEWEAVE_CONFIG: f })).toThrow(/Duplicate/);
  });
  it('config parse errors never echo file content', () => {
    const dir = tmpHome();
    const f = join(dir, 'bad.json');
    writeFileSync(f, '{"connections":[{"token":"TOPSECRETVALUE" oops');
    try { loadSettings({ COMMERCEWEAVE_HOME: dir, COMMERCEWEAVE_CONFIG: f }); expect.unreachable(); }
    catch (e) { expect((e as Error).message).not.toContain('TOPSECRETVALUE'); expect((e as Error).message).toMatch(/invalid JSON/); }
  });
  it('a missing env reference is reported by variable name only', () => {
    const dir = tmpHome(); const f = join(dir, 'c.json');
    writeFileSync(f, JSON.stringify({ connections: [{ platform: 'baselinker', id: 'a', token: 'env:NOPE_VAR' }] }));
    expect(() => loadSettings({ COMMERCEWEAVE_HOME: dir, COMMERCEWEAVE_CONFIG: f })).toThrow(/NOPE_VAR/);
  });
});

describe('token store', () => {
  const t = { accessToken: 'AT-secret-value', refreshToken: 'RT-secret-value', expiresAt: 123 };
  it('encrypts at rest when a key is configured and refuses the wrong key', () => {
    const home = tmpHome();
    new TokenStore(home, 'passphrase').save('allegro', t);
    const raw = readFileSync(join(home, 'tokens', 'allegro.json'), 'utf8');
    expect(raw).not.toContain('RT-secret-value');
    expect(new TokenStore(home, 'passphrase').load('allegro')).toEqual(t);
    expect(() => new TokenStore(home, 'wrong').load('allegro')).toThrow(/decrypt/);
    expect(() => new TokenStore(home).load('allegro')).toThrow(/encrypted/);
  });
  it('plaintext mode is explicit and rejects path-like connection ids', () => {
    const home = tmpHome();
    const s = new TokenStore(home);
    expect(s.encrypted).toBe(false);
    s.save('allegro', t);
    expect(s.load('allegro')).toEqual(t);
    mkdirSync(join(home, 'x'), { recursive: true });
    expect(() => s.save('../evil', t)).toThrow(CommerceError);
  });
});

describe('duplicate detection', () => {
  const o = (platform: CommerceOrder['source']['platform'], id: string, extra: Partial<CommerceOrder> = {}, srcExtra: Record<string, string> = {}): CommerceOrder => ({
    source: { connectionId: platform, platform, externalId: id, extra: srcExtra }, createdAt: '2026-11-13T10:00:00Z', platformStatus: 's', state: 'open', stateClassified: true,
    total: { amount: '10.00', currency: 'PLN' }, items: [], customer: { redacted: true }, ...extra,
  });
  it('confirms Allegro->Base imports by exact id, keeps unrelated orders untouched', () => {
    const r = markDuplicates([o('allegro', 'A1'), o('allegro', 'A2'), o('baselinker', 'B1', { importedFrom: { system: 'allegro', externalOrderId: 'A1' } })]);
    expect(r.find((x) => x.source.externalId === 'B1')?.duplicate?.status).toBe('confirmed');
    expect(r.filter((x) => x.duplicate)).toHaveLength(1);
  });
  it('an import whose source order is unknown is NOT marked (nothing is silently dropped)', () => {
    const r = markDuplicates([o('baselinker', 'B1', { importedFrom: { system: 'allegro', externalOrderId: 'GONE' } })]);
    expect(r[0]?.duplicate).toBeUndefined();
  });
  it('same shop id + total across Base and Woo is only "potential"; different totals are not flagged', () => {
    const base = o('baselinker', 'B9', { importedFrom: { system: 'shop', externalOrderId: '55' } }, { shopOrderId: '55' });
    expect(markDuplicates([base, o('woocommerce', '55')])[0]?.duplicate?.status).toBe('potential');
    expect(markDuplicates([base, o('woocommerce', '55', { total: { amount: '11.00', currency: 'PLN' } })])[0]?.duplicate).toBeUndefined();
  });
});

describe('approval screen display safety', () => {
  it('neutralises newlines, ANSI escapes, bidi and zero-width characters in untrusted values', async () => {
    const { safeDisplay, hasUnsafeChars } = await import('../../src/core/display.js');
    const evil = 'ok\n  after:  99.99 PLN\u001b[2J\u202Eevil\u200B';
    const shown = safeDisplay(evil);
    expect(shown).not.toMatch(/[\n\u001b\u202e\u200b]/);
    expect(shown).toContain('\\n');
    expect(shown).toContain('\\x1b');
    expect(hasUnsafeChars(evil)).toBe(true);
    expect(hasUnsafeChars('Plain note, ąęł 123')).toBe(false);
    expect(safeDisplay('x'.repeat(1000)).endsWith('[truncated]')).toBe(true);
  });
});

describe('Base ids', () => {
  it('only plain integers are accepted', async () => {
    const { intId } = await import('../../src/connectors/baselinker/index.js');
    expect(intId('12345', 'x')).toBe(12345);
    for (const bad of ['12abc', '1e3', '-1', '1.5', '', ' 7', '0x10', '1'.repeat(13)]) expect(() => intId(bad, 'x'), bad).toThrow(CommerceError);
    expect(() => intId(undefined, 'x')).toThrow();
  });
});
