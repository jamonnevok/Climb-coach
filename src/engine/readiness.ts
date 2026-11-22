/**
 * READINESS — daily score 0-100 from the 30-second check-in plus last night's sleep
 * compared with the personal baseline. It only PROPOSES (proceed / lighter / rest);
 * the user validates. Finger status is handled separately: a low finger status
 * proposes a finger-work downgrade whatever the global score.
 */
import { rules as defaultRules, type Rules } from '../config';
import { addDays, type ISODate } from '../lib/dates';
import type { DailyCheckin, Settings, SleepRecord, TrainingMode } from '../data/schema';

export type ReadinessAdvice = 'proceed' | 'lighter' | 'rest';

export interface ReadinessResult {
  date: ISODate;
  score: number | null;
  advice: ReadinessAdvice | null;
  fingerLow: boolean;
  sleepH: number | null;
  sleepBaselineH: number;
  sleepBelowBaseline: boolean;
  components: Record<string, number>;
  reasons: string[];
}

const to100 = (v: number) => ((v - 1) / 4) * 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Sleep for the night ending on `date`. Garmin preferred over manual when both exist. */
export function sleepForDate(sleep: SleepRecord[], date: ISODate): SleepRecord | undefined {
  const s = sleep.filter((r) => !r.deleted && r.date === date);
  return s.find((r) => r.source === 'garmin') ?? s[0];
}

/** Personal baseline: explicit setting, else median of last N days (needs min records), else default. */
export function sleepBaseline(sleep: SleepRecord[], settings: Pick<Settings, 'sleepBaselineH'>, asOf: ISODate, r: Rules = defaultRules): number {
  if (settings.sleepBaselineH) return settings.sleepBaselineH;
  const from = addDays(asOf, -r.readiness.baselineWindowDays);
  const days = new Map<ISODate, number>();
  for (const rec of sleep) {
    if (rec.deleted || rec.date < from || rec.date >= asOf) continue;
    if (!days.has(rec.date) || rec.source === 'garmin') days.set(rec.date, rec.durationH);
  }
  const vals = [...days.values()];
  return vals.length >= r.readiness.baselineMinRecords ? Math.round(median(vals) * 100) / 100 : r.readiness.defaultSleepBaselineH;
}

export function computeReadiness(
  checkin: DailyCheckin | undefined,
  sleep: SleepRecord | undefined,
  baselineH: number,
  mode: TrainingMode,
  r: Rules = defaultRules,
): ReadinessResult {
  const date = checkin?.date ?? sleep?.date ?? '';
  const sleepH = sleep ? sleep.durationH : null;
  const shortfall = sleepH === null ? 0 : baselineH - sleepH;
  const sleepBelow = sleepH !== null && shortfall > r.readiness.sleepShortfallH;
  if (!checkin) {
    return { date, score: null, advice: null, fingerLow: false, sleepH, sleepBaselineH: baselineH, sleepBelowBaseline: sleepBelow, components: {}, reasons: ['No check-in yet today.'] };
  }
  const w = { ...r.readiness.weights };
  if (mode === 'newborn') {
    // Fragmented sleep is expected: sleep matters less to the score; weights renormalised below.
    w.sleepDuration *= r.readiness.newbornSleepWeightFactor;
    w.sleepQuality *= r.readiness.newbornSleepWeightFactor;
  }
  // Sleep duration score: 100 at/above baseline, 0 at 3 h below baseline.
  const sleepDurScore = sleepH === null ? null : Math.max(0, Math.min(100, 100 - (Math.max(0, shortfall) / 3) * 100));
  const sleepQ = sleep?.quality ?? checkin.sleepQuality;
  const comps: Record<string, number | null> = {
    fatigue: to100(checkin.fatigue),
    soreness: to100(checkin.soreness),
    stress: to100(checkin.stress),
    motivation: to100(checkin.motivation),
    sleepQuality: to100(sleepQ),
    sleepDuration: sleepDurScore,
    fingerStatus: to100(checkin.fingerStatus),
  };
  let sum = 0;
  let wsum = 0;
  const components: Record<string, number> = {};
  for (const [k, v] of Object.entries(comps)) {
    if (v === null) continue;
    const wk = w[k as keyof typeof w];
    sum += v * wk;
    wsum += wk;
    components[k] = Math.round(v);
  }
  const score = Math.round(sum / wsum);
  const th = mode === 'newborn' ? r.readiness.thresholds.newborn : r.readiness.thresholds.normal;
  const advice: ReadinessAdvice = score >= th.proceed ? 'proceed' : score >= th.lighter ? 'lighter' : 'rest';
  const fingerLow = checkin.fingerStatus <= r.readiness.fingerStatusDowngradeAt;
  const reasons: string[] = [];
  if (advice !== 'proceed') reasons.push(`Readiness ${score}/100 (proceed ≥ ${th.proceed}).`);
  if (sleepBelow) reasons.push(`Slept ${sleepH} h vs baseline ${baselineH} h.`);
  if (fingerLow) reasons.push(`Finger status ${checkin.fingerStatus}/5 — finger work should be downgraded.`);
  if (checkin.fatigue <= 2) reasons.push('High fatigue.');
  if (checkin.soreness <= 2) reasons.push('High soreness.');
  return { date, score, advice, fingerLow, sleepH, sleepBaselineH: baselineH, sleepBelowBaseline: sleepBelow, components, reasons };
}

/** Readiness for each of the last `days` days ending on asOf (inclusive). */
export function readinessSeries(
  checkins: DailyCheckin[],
  sleep: SleepRecord[],
  settings: Pick<Settings, 'sleepBaselineH' | 'mode'>,
  asOf: ISODate,
  days: number,
  r: Rules = defaultRules,
): ReadinessResult[] {
  const out: ReadinessResult[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(asOf, -i);
    const base = sleepBaseline(sleep, settings, d, r);
    const c = checkins.find((x) => !x.deleted && x.date === d);
    out.push({ ...computeReadiness(c, sleepForDate(sleep, d), base, settings.mode, r), date: d });
  }
  return out;
}

/** Longest run of consecutive days, ending on the last day of the series, matching `pred`. */
export function trailingRun<T>(series: T[], pred: (x: T) => boolean): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0 && pred(series[i]); i--) n++;
  return n;
}
