/**
 * PAIN MONITORING (traffic light) — adapted from the pain-monitoring model of
 * Silbernagel et al. 2007 (Achilles tendinopathy); application to fingers is an extrapolation.
 *   pain ≤ 2/10 and not worse next morning  -> GREEN  continue
 *   pain 3-5/10                             -> AMBER  modify (remove aggravating grip, lower intensity, add rest, re-check in 48 h)
 *   pain > 5/10 or worse next morning       -> RED    stop that loading, switch to rehab protocol
 *   any red flag                            -> RED FLAG: stop and see a physio
 * This is not a diagnosis. The UI always shows the medical disclaimer.
 */
import { rules as defaultRules, type Rules } from '../config';
import { addDays, diffDays, type ISODate } from '../lib/dates';
import type { BodyLocation, Grip, PainEntry, RedFlag } from '../data/schema';

export type PainLight = 'green' | 'amber' | 'red' | 'red_flag';

export const RED_FLAG_LABELS: Record<RedFlag, string> = {
  audible_pop: 'Audible pop',
  bowstringing: 'Bowstringing (tendon lifts away from the bone)',
  swelling: 'Swelling',
  pain_at_rest_gt3: 'Pain at rest above 3/10',
  no_improvement_2w: 'No improvement after 2 weeks',
};

export function locationKey(l: BodyLocation): string {
  if (l.region === 'finger') return `finger:${l.side}:${l.finger}:${l.structure}`;
  if (l.region === 'skin') return `skin:${l.side}:${l.finger ?? ''}`;
  return `${l.region}:${l.side}`;
}

export function locationLabel(l: BodyLocation): string {
  const side = l.side === 'left' ? 'L' : 'R';
  if (l.region === 'finger') return `${side} ${l.finger} ${l.structure}`;
  if (l.region === 'skin') return `${side} skin${l.finger ? ` (${l.finger})` : ''}`;
  return `${side} ${l.region}`;
}

export interface PainEvaluation {
  key: string;
  location: BodyLocation;
  light: PainLight;
  maxPain: number;
  worseNextMorning: boolean;
  redFlags: RedFlag[];
  aggravatingGrips: Grip[];
  firstSeen: ISODate;
  lastSeen: ISODate;
  reasons: string[];
}

export function classify(maxPain: number, worseNextMorning: boolean, redFlags: RedFlag[], r: Rules = defaultRules): PainLight {
  if (redFlags.length) return 'red_flag';
  if (maxPain > r.pain.modifyMax || worseNextMorning) return 'red';
  if (maxPain > r.pain.continueMax) return 'amber';
  return 'green';
}

/**
 * Evaluate each location with entries in the last `windowDays` (default 3).
 * "Worse next morning": a next_morning entry higher than the previous morning's value
 * (or than the previous day's 'rest' baseline when no previous morning exists).
 * Adds the 'no_improvement_2w' red flag when pain > continueMax has persisted ≥ 14 days without decreasing.
 */
export function evaluatePain(entries: PainEntry[], asOf: ISODate, windowDays = 3, r: Rules = defaultRules): PainEvaluation[] {
  const live = entries.filter((e) => !e.deleted && e.date <= asOf);
  const byKey = new Map<string, PainEntry[]>();
  for (const e of live) (byKey.get(locationKey(e.location)) ?? byKey.set(locationKey(e.location), []).get(locationKey(e.location))!).push(e);
  const from = addDays(asOf, -(windowDays - 1));
  const out: PainEvaluation[] = [];
  for (const [key, all] of byKey) {
    all.sort((a, b) => a.at.localeCompare(b.at));
    const recent = all.filter((e) => e.date >= from);
    if (!recent.length) continue;
    const maxPain = Math.max(...recent.map((e) => e.pain));
    const mornings = all.filter((e) => e.moment === 'next_morning');
    const lastM = mornings[mornings.length - 1];
    const prevM = mornings[mornings.length - 2];
    const worse = !!lastM && lastM.date >= from && !!prevM && lastM.pain > prevM.pain;
    const flags = new Set<RedFlag>(recent.flatMap((e) => e.redFlags));
    const painful = all.filter((e) => e.pain > r.pain.continueMax);
    const firstSeen = all[0].date;
    if (painful.length && diffDays(painful[0].date, asOf) >= r.pain.noImprovementDays) {
      const early = Math.max(...painful.filter((e) => diffDays(painful[0].date, e.date) <= 3).map((e) => e.pain));
      const late = Math.max(...recent.map((e) => e.pain));
      if (late > r.pain.continueMax && late >= early) flags.add('no_improvement_2w');
    }
    const redFlags = [...flags];
    const light = classify(maxPain, worse, redFlags, r);
    const reasons: string[] = [];
    if (redFlags.length) reasons.push(`Red flag: ${redFlags.map((f) => RED_FLAG_LABELS[f]).join(', ')}.`);
    if (maxPain > r.pain.continueMax) reasons.push(`Pain up to ${maxPain}/10.`);
    if (worse) reasons.push('Worse the next morning.');
    out.push({
      key,
      location: recent[recent.length - 1].location,
      light,
      maxPain,
      worseNextMorning: worse,
      redFlags,
      aggravatingGrips: [...new Set(recent.map((e) => e.aggravatingGrip).filter((g): g is Grip => !!g))],
      firstSeen,
      lastSeen: recent[recent.length - 1].date,
      reasons,
    });
  }
  const order: PainLight[] = ['red_flag', 'red', 'amber', 'green'];
  return out.sort((a, b) => order.indexOf(a.light) - order.indexOf(b.light) || b.maxPain - a.maxPain);
}

/** Daily max finger pain (0 if no entry) over [from, to]. */
function dailyFingerMax(entries: PainEntry[], from: ISODate, to: ISODate): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const xs = entries.filter((e) => !e.deleted && e.date === d && e.location.region === 'finger').map((e) => e.pain);
    out.push(xs.length ? Math.max(...xs) : 0);
  }
  return out;
}

/** Finger pain trend rising: mean daily max over the last N days exceeds the previous N days by ≥ minIncrease. */
export function fingerPainTrendRising(entries: PainEntry[], asOf: ISODate, r: Rules = defaultRules): boolean {
  const n = r.deload.painTrendWindowDays;
  const cur = dailyFingerMax(entries, addDays(asOf, -(n - 1)), asOf);
  const prev = dailyFingerMax(entries, addDays(asOf, -(2 * n - 1)), addDays(asOf, -n));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean(cur) - mean(prev) >= r.deload.painTrendMinIncrease / 2 && Math.max(...cur) - Math.max(...prev) >= r.deload.painTrendMinIncrease;
}

export function recentFingerPainMax(entries: PainEntry[], asOf: ISODate, days = 3): number {
  const from = addDays(asOf, -(days - 1));
  const xs = entries.filter((e) => !e.deleted && e.date >= from && e.date <= asOf && e.location.region === 'finger').map((e) => e.pain);
  return xs.length ? Math.max(...xs) : 0;
}

/** Suggest a generic rehab protocol id for a location (config/rehab-protocols.json). */
export function protocolFor(l: BodyLocation): string | null {
  if (l.region === 'finger') return 'pulley_strain';
  if (l.region === 'elbow') return 'elbow_tendinopathy';
  if (l.region === 'shoulder') return 'shoulder';
  return null;
}
