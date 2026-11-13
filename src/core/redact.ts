const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|consumer_key|consumer_secret|client_secret|refresh)/i;

const known = new Set<string>();
/** Register a credential value so that it is masked wherever it might show up in text. */
export function registerSecret(v: string | undefined) {
  if (v && v.length >= 6) known.add(v);
}
export function clearSecretsForTests() {
  known.clear();
}

export function maskString(s: string): string {
  let out = s;
  for (const k of known) out = out.split(k).join('[REDACTED]');
  out = out.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]');
  out = out.replace(/(consumer_(?:key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
  return out;
}

export function maskDeep(v: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (typeof v === 'string') return maskString(v);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? '[REDACTED]' : maskDeep(val, depth + 1);
    return o;
  }
  return v;
}

export function maskEmail(e: string | undefined | null): string | undefined {
  if (!e) return undefined;
  const [u = '', d = ''] = e.split('@');
  return `${u.slice(0, 1)}***@${d}`;
}
export function maskPhone(p: string | undefined | null): string | undefined {
  if (!p) return undefined;
  return p.length <= 4 ? '***' : `***${p.slice(-3)}`;
}
export function maskName(n: string | undefined | null): string | undefined {
  if (!n) return undefined;
  return n
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.slice(0, 1) + '.')
    .join(' ');
}
