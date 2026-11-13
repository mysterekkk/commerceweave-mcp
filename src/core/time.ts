import { CommerceError } from './errors.js';

function offsetMs(tz: string, at: Date): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export function assertTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new CommerceError('VALIDATION_FAILED', `Unknown IANA timezone "${tz}" (example: Europe/Warsaw)`);
  }
}

/** UTC instant of local midnight (00:00) for the calendar day `ymd` in `tz`. */
export function startOfDayUtc(ymd: string, tz: string): Date {
  assertTimezone(tz);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d) - offsetMs(tz, new Date(guess));
  return new Date(guess);
}

export function localYmd(at: Date, tz: string): string {
  assertTimezone(tz);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface Range { from: Date; to: Date; timezone: string; label: string }

/** "today" = [local midnight, now]. "last N days" = N full local days ending now (N-1 days back + today). */
export function resolveRange(a: { date?: string; days?: number; from?: string; to?: string; timezone: string }, now = new Date()): Range {
  const tz = a.timezone;
  assertTimezone(tz);
  if (a.from || a.to) {
    const from = a.from ? new Date(a.from) : new Date(now.getTime() - 86_400_000);
    const to = a.to ? new Date(a.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new CommerceError('VALIDATION_FAILED', 'Invalid from/to range (use ISO 8601 and from <= to)');
    return { from, to, timezone: tz, label: `${from.toISOString()} .. ${to.toISOString()}` };
  }
  if (a.days) {
    const today = localYmd(now, tz);
    const first = addDaysYmd(today, -(a.days - 1));
    return { from: startOfDayUtc(first, tz), to: now, timezone: tz, label: `last ${a.days} day(s): ${first} .. ${today} (${tz}, incl. today so far)` };
  }
  const day = a.date ?? localYmd(now, tz);
  const next = addDaysYmd(day, 1);
  const end = new Date(startOfDayUtc(next, tz).getTime() - 1);
  return { from: startOfDayUtc(day, tz), to: a.date ? end : now, timezone: tz, label: `${day} (${tz})` };
}
