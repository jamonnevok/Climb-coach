/**
 * Recovery rules shared by the generator, manual edits (drag & drop) and the adaptation engine.
 *  - never two sessions on the same day (prehab slots excepted);
 *  - no back-to-back high/max finger days;
 *  - at least `minDaysBetweenMaxFinger` days between max finger sessions;
 *  - no session on an unavailable day.
 */
import { rules as defaultRules, type Rules } from '../config';
import { diffDays, weekdayIndex, type ISODate } from '../lib/dates';
import type { FingerIntensity, PlannedSession } from '../data/schema';

export type RuleId = 'same_day' | 'back_to_back_high' | 'max_spacing' | 'unavailable';

export interface RuleViolation {
  rule: RuleId;
  sessionId: string;
  otherSessionId?: string;
  date: ISODate;
  message: string;
}

const ORDER: FingerIntensity[] = ['none', 'low', 'moderate', 'high', 'max'];
export const intensityRank = (i: FingerIntensity) => ORDER.indexOf(i);
export const isHigh = (s: Pick<PlannedSession, 'fingerIntensity'>) => intensityRank(s.fingerIntensity) >= 3;
export const isMax = (s: Pick<PlannedSession, 'fingerIntensity'>) => s.fingerIntensity === 'max';
export const maxIntensity = (xs: FingerIntensity[]) => xs.reduce<FingerIntensity>((m, x) => (intensityRank(x) > intensityRank(m) ? x : m), 'none');

const active = (s: PlannedSession) => s.status === 'planned' || s.status === 'done' || s.status === 'moved';

export interface RuleContext {
  unavailableDates?: ISODate[];
  unavailableWeekdays?: number[];
  rules?: Rules;
}

/**
 * Check every rule over a set of sessions (pass neighbouring weeks too, so boundaries are checked).
 * Optional sessions and prehab slots are ignored for spacing rules.
 */
export function checkRules(sessions: PlannedSession[], ctx: RuleContext = {}): RuleViolation[] {
  const r = (ctx.rules ?? defaultRules).recovery;
  const out: RuleViolation[] = [];
  const list = sessions.filter(active).filter((s) => s.kind !== 'prehab' && !s.optional).sort((a, b) => a.date.localeCompare(b.date));
  const unavailable = new Set(ctx.unavailableDates ?? []);
  for (const s of sessions.filter(active)) {
    if (s.status !== 'planned') continue;
    if (unavailable.has(s.date) || (ctx.unavailableWeekdays ?? []).includes(weekdayIndex(s.date))) {
      out.push({ rule: 'unavailable', sessionId: s.id, date: s.date, message: `${s.title} is on an unavailable day.` });
    }
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const gap = diffDays(a.date, b.date);
      if (gap > Math.max(1, r.minDaysBetweenMaxFinger)) break;
      if (gap === 0 && r.maxSessionsPerDay <= 1) {
        out.push({ rule: 'same_day', sessionId: b.id, otherSessionId: a.id, date: b.date, message: `Two sessions on ${b.date} — never stack sessions.` });
      }
      if (gap === 1 && r.noBackToBackHighFinger && isHigh(a) && isHigh(b)) {
        out.push({ rule: 'back_to_back_high', sessionId: b.id, otherSessionId: a.id, date: b.date, message: `${a.title} and ${b.title} are high finger-load days back to back.` });
      }
      if (gap > 0 && gap < r.minDaysBetweenMaxFinger && isMax(a) && isMax(b)) {
        out.push({ rule: 'max_spacing', sessionId: b.id, otherSessionId: a.id, date: b.date, message: `Max finger sessions need ≥ ${r.minDaysBetweenMaxFinger} days between them.` });
      }
    }
  }
  return out;
}

/** True if placing `candidate` on `date` breaks no rule given the other sessions. */
export function canPlace(candidate: PlannedSession, date: ISODate, others: PlannedSession[], ctx: RuleContext = {}): boolean {
  const moved = { ...candidate, date, status: 'planned' as const };
  const pool = [...others.filter((o) => o.id !== candidate.id), moved];
  return checkRules(pool, ctx).filter((v) => v.sessionId === moved.id || v.otherSessionId === moved.id).length === 0;
}
