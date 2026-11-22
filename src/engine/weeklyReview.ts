/**
 * WEEKLY REVIEW (Sunday, ~2 min).
 * Summarises the week just ending and bundles next-week adjustments into ONE proposal
 * (accept / edit / reject in one tap), plus a separate early-deload proposal when triggered.
 */
import { rules as defaultRules, type Rules } from '../config';
import { addDays, startOfWeek, type ISODate } from '../lib/dates';
import type { BenchmarkResult, ExerciseDef, Plan, SessionLog, WeeklyReviewSummary } from '../data/schema';
import { evaluateDeloadTriggers, makeProposal, proposeDeload, type DeloadSignals, type ProposalDraft, type WeeklyChange } from './adaptation';
import type { Library } from './library';
import { computeACWR, weekOnWeek, weekTotals, type DatedLoad } from './load';
import { suggestProgression } from './progression';
import { allSessions } from './planOps';
import type { ReadinessResult } from './readiness';
import type { PainEntry, ColdStartSeed } from '../data/schema';

export interface WeeklyReviewInput {
  weekStart: ISODate; // Monday of the week being reviewed
  plan: Plan;
  loads: DatedLoad[];
  sessions: SessionLog[];
  readiness: ReadinessResult[]; // ≥ 14 days ending on the review day
  pain: PainEntry[];
  benchmarks: BenchmarkResult[];
  library: Library;
  bodyMassKg: number;
  coldStart: ColdStartSeed | null;
  fingerStatusLowToday: boolean;
  recentFingerPainMax: number;
  failedProgressions: number;
  rules?: Rules;
}

export interface WeeklyReviewOutput {
  summary: WeeklyReviewSummary;
  proposals: ProposalDraft[];
  changes: WeeklyChange[];
}

export function buildWeeklyReview(inp: WeeklyReviewInput): WeeklyReviewOutput {
  const r = inp.rules ?? defaultRules;
  const ws = startOfWeek(inp.weekStart);
  const we = addDays(ws, 6);
  const nextWs = addDays(ws, 7);
  const tot = weekTotals(inp.loads, ws);
  const g = computeACWR(inp.loads, { metric: 'global', asOf: we, coldStart: inp.coldStart });
  const f = computeACWR(inp.loads, { metric: 'finger', asOf: we, coldStart: inp.coldStart });
  const wow = weekOnWeek(inp.loads, ws, inp.coldStart);
  const weekRd = inp.readiness.filter((x) => x.date >= ws && x.date <= we);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const planned = allSessions(inp.plan).filter((s) => s.date >= ws && s.date <= we && !s.optional && s.kind !== 'prehab');
  const done = planned.filter((s) => s.status === 'done').length;
  const adherencePct = planned.length ? Math.round((done / planned.length) * 100) : 100;
  const weekPain = inp.pain.filter((p) => !p.deleted && p.date >= ws && p.date <= we);
  const benchNotes = inp.benchmarks
    .filter((b) => !b.deleted && b.date >= ws && b.date <= we)
    .map((b) => `${b.type.replace(/_/g, ' ')}: ${b.value} (${b.unit})`);

  const summary: WeeklyReviewSummary = {
    globalLoad: tot.global,
    fingerLoad: tot.finger,
    globalACWR: g.ratio,
    fingerACWR: f.ratio,
    avgSleepH: avg(weekRd.map((x) => x.sleepH).filter((x): x is number => x !== null)),
    avgReadiness: avg(weekRd.map((x) => x.score).filter((x): x is number => x !== null)),
    maxPain: weekPain.length ? Math.max(...weekPain.map((p) => p.pain)) : 0,
    adherencePct,
    benchmarkNotes: benchNotes,
  };

  const changes: WeeklyChange[] = [];
  const reasons: string[] = [];

  // 1. Progression suggestions from this week's logged sets, applied to next week's items.
  const byEx = new Map<string, { sets: SessionLog['sets']; prevFailed: boolean }>();
  const weekLogs = inp.sessions.filter((s) => !s.deleted && s.date >= ws && s.date <= we).sort((a, b) => a.date.localeCompare(b.date));
  for (const log of weekLogs) {
    for (const set of log.sets) {
      const cur = byEx.get(set.exerciseId);
      if (!cur) byEx.set(set.exerciseId, { sets: [set], prevFailed: false });
      else if (cur.sets[0].at.slice(0, 10) === set.at.slice(0, 10)) cur.sets.push(set);
      else byEx.set(set.exerciseId, { sets: [set], prevFailed: cur.sets.some((x) => !x.completed) });
    }
  }
  const nextItems = allSessions(inp.plan).filter((s) => s.date >= nextWs && s.status === 'planned').flatMap((s) => s.items);
  for (const [exId, { sets, prevFailed }] of byEx) {
    const ex: ExerciseDef | undefined = inp.library.get(exId);
    const item = nextItems.find((i) => i.exerciseId === exId && i.load.value !== null);
    if (!ex || !item) continue;
    const sug = suggestProgression({
      exercise: ex,
      lastSets: sets,
      previousFailed: prevFailed,
      bodyMassKg: inp.bodyMassKg,
      current: item.load,
      fingerStatusLow: inp.fingerStatusLowToday,
      recentFingerPainMax: inp.recentFingerPainMax,
    }, r);
    if ((sug.action === 'increase' || sug.action === 'decrease') && sug.newValue !== null) {
      changes.push({ type: 'progression', exerciseId: exId, mode: item.load.mode, value: sug.newValue, fromDate: nextWs });
      reasons.push(`${ex.name}: ${sug.reason}`);
    }
  }

  // 2. Finger week-on-week flag -> trim next week's finger volume by 10 %.
  if (wow.fingerFlag) {
    changes.push({ type: 'scale_finger_volume', weekStart: nextWs, factor: 0.9 });
    reasons.push(`Finger load rose ${wow.fingerPct} % this week: next week's finger volume −10 %.`);
  }

  // 3. Low adherence -> suggest one fewer session per week.
  const spw = inp.plan.weeks[0]?.sessions.filter((s) => !s.optional && s.kind !== 'prehab' && s.kind !== 'outdoor').length ?? 3;
  if (adherencePct < r.weeklyReview.adherenceLowPct && planned.length >= 3 && spw > 2) {
    changes.push({ type: 'sessions_per_week', value: spw - 1 });
    reasons.push(`Adherence ${adherencePct} %: plan ${spw - 1} sessions/week for now (re-generates the plan).`);
  }

  const proposals: ProposalDraft[] = [];
  if (changes.length) {
    proposals.push(makeProposal('weekly_adjustment', `Weekly review — ${changes.length} adjustment(s) for next week`, reasons.join(' '), ['weekly_review'], { changes, weekStart: nextWs }, addDays(nextWs, 2)));
  }

  const signals: DeloadSignals = {
    fingerAcwr: f,
    fingerWeekOnWeek: wow,
    readiness: inp.readiness.filter((x) => x.date <= we),
    pain: inp.pain,
    failedProgressions: inp.failedProgressions,
    asOf: we,
  };
  const dl = evaluateDeloadTriggers(signals, r);
  if (dl.propose) {
    const p = proposeDeload(inp.plan, addDays(we, 1), dl.triggers);
    if (p) proposals.push(p);
  }
  return { summary, proposals, changes };
}

/** Count failed finger progressions (sessions with ≥ 1 incomplete finger set) in the rules window. */
export function countFailedProgressions(sessions: SessionLog[], library: Library, asOf: ISODate, r: Rules = defaultRules): number {
  const from = addDays(asOf, -r.deload.failedProgressionWindowDays);
  return sessions.filter(
    (s) => !s.deleted && s.date >= from && s.date <= asOf && s.sets.some((x) => !x.completed && library.get(x.exerciseId)?.category === 'finger'),
  ).length;
}
