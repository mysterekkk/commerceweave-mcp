import { CommerceError } from './errors.js';

/** Exact decimal arithmetic on a fixed 6-digit scale. No floating point in money maths. */
const SCALE = 6;
const ONE = 10n ** BigInt(SCALE);

function numberToString(n: number): string {
  if (!Number.isFinite(n)) throw new CommerceError('VALIDATION_FAILED', 'Non-finite amount');
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function parseDecimal(input: string | number): bigint {
  let s = typeof input === 'number' ? numberToString(input) : String(input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new CommerceError('VALIDATION_FAILED', `Invalid decimal amount: ${JSON.stringify(input)}`);
  }
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [i = '0', f = ''] = s.split('.');
  if (f.length > SCALE && /[1-9]/.test(f.slice(SCALE))) {
    throw new CommerceError('VALIDATION_FAILED', `Too many decimals: ${input}`);
  }
  const frac = (f + '0'.repeat(SCALE)).slice(0, SCALE);
  const v = BigInt(i) * ONE + BigInt(frac);
  return neg ? -v : v;
}

/** Round half away from zero to `dp` decimals. */
export function roundDecimal(v: bigint, dp = 2): bigint {
  const unit = 10n ** BigInt(SCALE - dp);
  const half = unit / 2n;
  const abs = v < 0n ? -v : v;
  const r = ((abs + half) / unit) * unit;
  return v < 0n ? -r : r;
}

export function formatDecimal(v: bigint, dp = 2): string {
  const r = roundDecimal(v, dp);
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const i = abs / ONE;
  const f = (abs % ONE).toString().padStart(SCALE, '0').slice(0, dp);
  return `${neg ? '-' : ''}${i}${dp > 0 ? '.' + f : ''}`;
}

/** price * (1 + percent/100); percent is a decimal string such as "5" or "-2.5". */
export function applyPercent(price: bigint, percent: string | number): bigint {
  const p = parseDecimal(percent);
  return price + (price * p) / (100n * ONE);
}

export function normalizeMoney(input: string | number): string {
  return formatDecimal(parseDecimal(input), 2);
}
