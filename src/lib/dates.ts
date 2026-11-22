/**
 * Date helpers. All calendar dates are local "YYYY-MM-DD" strings (ISODate);
 * all timestamps are full ISO strings in UTC (ISODateTime).
 * Weeks start on Monday (ISO 8601). Day index: 0 = Monday ... 6 = Sunday.
 */
export type ISODate = string;
export type ISODateTime = string;

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse "YYYY-MM-DD" as a local date at 12:00 to avoid DST edge cases. */
export function parseISODate(s: ISODate): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function todayISO(now: Date = new Date()): ISODate {
  return toISODate(now);
}

export function nowISO(now: Date = new Date()): ISODateTime {
  return now.toISOString();
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = parseISODate(date);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: ISODate, b: ISODate): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** 0 = Monday ... 6 = Sunday */
export function weekdayIndex(date: ISODate): number {
  return (parseISODate(date).getDay() + 6) % 7;
}

export function startOfWeek(date: ISODate): ISODate {
  return addDays(date, -weekdayIndex(date));
}

export function dateRange(start: ISODate, endInclusive: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = start; diffDays(d, endInclusive) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isValidISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return toISODate(parseISODate(s)) === s;
}
