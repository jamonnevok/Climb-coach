/**
 * "WHAT PRECEDED MY INJURIES" — descriptive, not predictive.
 * For each injury episode, look at the 4 weeks before its start (and the last 2 weeks
 * separately) and compare with your personal typical values outside injury windows:
 * finger load, finger ACWR peak, restricted-grip share, readiness, sleep vs baseline,
 * week-on-week finger spikes. Patterns that recur before ≥ 2 episodes are listed.
 * Small numbers: this is a reflection aid, not statistics.
 */
import { addDays, type ISODate } from '../lib/dates';
import type { ColdStartSeed, InjuryEpisode } from '../data/schema';
import { computeACWR, weekTotals, type DatedLoad } from './load';
import { locationLabel } from './pain';
import type { ReadinessResult } from './readiness';

export interface WindowStats {
  from: ISODate;
  to: ISODate;
  fingerLoadPerWeek: number;
  fingerAcwrPeak: number | null;
  restrictedSharePct: number;
  avgReadiness: number | null;
  avgSleepH: number | null;
  nightsBelowBaseline: number;
  maxFingerWeekJumpPct: number | null;
}

export interface EpisodeAnalysis {
  injury: InjuryEpisode;
  label: string;
  w4: WindowStats;
  w2: WindowStats;
  flags: string[];
}

export interface PrecededReport {
  episodes: EpisodeAnalysis[];
  typical: WindowStats | null;
  recurring: { flag: string; count: number }[];
  note: string;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

export function windowStats(
  loads: DatedLoad[],
  readiness: ReadinessResult[],
  from: ISODate,
  to: ISODate,
  coldStart: ColdStartSeed | null,
): WindowStats {
  const inWin = loads.filter((l) => l.date >= from && l.date <= to);
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
  const finger = inWin.reduce((a, l) => a + l.fingerLoad, 0);
  const restricted = inWin.reduce((a, l) => a + l.restrictedGripLoad, 0);
  const acwr = computeACWR(loads, { metric: 'finger', asOf: to, coldStart });
  const ratios = acwr.series.filter((p) => p.date >= from && p.ratio !== null).map((p) => p.ratio as number);
  const rd = readiness.filter((r) => r.date >= from && r.date <= to);
  let maxJump: number | null = null;
  for (let ws = from; ws <= to; ws = addDays(ws, 7)) {
    const cur = weekTotals(loads, ws).finger;
    const prev = weekTotals(loads, addDays(ws, -7)).finger;
    if (prev >= 20) {
      const j = ((cur - prev) / prev) * 100;
      maxJump = maxJump === null ? j : Math.max(maxJump, j);
    }
  }
  return {
    from,
    to,
    fingerLoadPerWeek: Math.round((finger / days) * 7 * 10) / 10,
    fingerAcwrPeak: ratios.length ? Math.max(...ratios) : null,
    restrictedSharePct: finger > 0 ? Math.round((restricted / finger) * 1000) / 10 : 0,
    avgReadiness: r1(avg(rd.map((r) => r.score).filter((x): x is number => x !== null))),
    avgSleepH: r1(avg(rd.map((r) => r.sleepH).filter((x): x is number => x !== null))),
    nightsBelowBaseline: rd.filter((r) => r.sleepBelowBaseline).length,
    maxFingerWeekJumpPct: r1(maxJump),
  };
}

export function analyseInjuries(
  injuries: InjuryEpisode[],
  loads: DatedLoad[],
  readiness: ReadinessResult[],
  coldStart: ColdStartSeed | null,
  asOf: ISODate,
): PrecededReport {
  const eps = injuries.filter((i) => !i.deleted).sort((a, b) => a.start.localeCompare(b.start));
  const inAnyWindow = (d: ISODate) => eps.some((e) => d >= addDays(e.start, -28) && d <= (e.end ?? asOf));
  // Typical = all logged days outside injury windows (and their recovery periods).
  const first = loads.reduce<ISODate | null>((m, l) => (m === null || l.date < m ? l.date : m), null);
  let typical: WindowStats | null = null;
  if (first) {
    const outsideLoads = loads.filter((l) => !inAnyWindow(l.date));
    const outsideRd = readiness.filter((r) => !inAnyWindow(r.date));
    if (outsideLoads.length >= 4) typical = windowStats(outsideLoads, outsideRd, first, asOf, coldStart);
  }
  const episodes: EpisodeAnalysis[] = eps.map((injury) => {
    const w4 = windowStats(loads, readiness, addDays(injury.start, -28), addDays(injury.start, -1), coldStart);
    const w2 = windowStats(loads, readiness, addDays(injury.start, -14), addDays(injury.start, -1), coldStart);
    const flags: string[] = [];
    if ((w4.fingerAcwrPeak ?? 0) > 1.3) flags.push('Finger ACWR above 1.3');
    if ((w4.maxFingerWeekJumpPct ?? 0) > 15) flags.push('Finger load jump > 15 % week-on-week');
    if (typical && w2.fingerLoadPerWeek > typical.fingerLoadPerWeek * 1.2) flags.push('Finger load > 120 % of your typical week (last 2 weeks)');
    if (typical ? w4.restrictedSharePct > typical.restrictedSharePct + 10 : w4.restrictedSharePct > 25) flags.push('More full-crimp / 2-finger pocket load than usual');
    if (w2.nightsBelowBaseline >= 4) flags.push('Short sleep (≥ 4 nights below baseline in the last 2 weeks)');
    if (typical?.avgReadiness !== null && typical?.avgReadiness !== undefined && w2.avgReadiness !== null && w2.avgReadiness < typical.avgReadiness - 10) {
      flags.push('Readiness clearly below your usual');
    }
    return { injury, label: `${locationLabel(injury.location)} — ${injury.start}`, w4, w2, flags };
  });
  const counts = new Map<string, number>();
  for (const e of episodes) for (const f of e.flags) counts.set(f, (counts.get(f) ?? 0) + 1);
  return {
    episodes,
    typical,
    recurring: [...counts.entries()].filter(([, c]) => c >= 2).map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count),
    note: 'Descriptive only: a few episodes cannot prove cause. Use recurring patterns as prompts for your own judgement and to discuss with a physio.',
  };
}
