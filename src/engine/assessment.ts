/**
 * ASSESSMENT — weakness ranking.
 * Each domain gets a 0-100 score (higher = stronger relative to the GOAL grade):
 *   50 % tests vs indicative norms, 30 % questionnaire, 20 % log trends.
 * Missing components are dropped and weights renormalised; `confidence` reflects how many
 * components contributed. Norms are coaching-practice heuristics (see norms.json caveat).
 */
import { norms as defaultNorms, type GradeNorm, type Norms } from '../config';
import { addDays, type ISODate } from '../lib/dates';
import { fontIndex, gradeDelta, SPORT_GRADES, sportIndex } from '../lib/grades';
import {
  FRONT_LEVER_LEVELS,
  type BenchmarkResult,
  type ClimbLog,
  type ProfileEntry,
  type QuestionId,
  type QuestionnaireResponse,
} from '../data/schema';
import { benchmarkValue, latestBenchmarks } from './library';

export type Domain = 'finger_strength' | 'power' | 'technique_transfer' | 'power_endurance' | 'pull_strength' | 'core';

export const DOMAIN_LABELS: Record<Domain, string> = {
  finger_strength: 'Finger strength',
  power: 'Power / bouldering',
  technique_transfer: 'Technique & outdoor transfer',
  power_endurance: 'Power endurance',
  pull_strength: 'Pulling strength',
  core: 'Core / body tension',
};

export const QUESTIONS: { id: QuestionId; text: string; domain: Domain | 'strength_area' }[] = [
  { id: 'technique_footwork', text: 'My footwork is precise and quiet on small footholds.', domain: 'technique_transfer' },
  { id: 'technique_body_position', text: 'I find efficient body positions (hips, flagging, drop-knees).', domain: 'technique_transfer' },
  { id: 'technique_outdoor_transfer', text: 'My board/gym level transfers well to outdoor rock.', domain: 'technique_transfer' },
  { id: 'power_dynamic', text: 'I am good at dynamic and big moves.', domain: 'power' },
  { id: 'power_contact_strength', text: 'I can catch and hold poor holds after a move (contact strength).', domain: 'power' },
  { id: 'finger_small_crimps', text: 'Small crimps rarely stop me.', domain: 'finger_strength' },
  { id: 'finger_pockets', text: 'Pockets (2-3 fingers) feel strong and safe.', domain: 'finger_strength' },
  { id: 'power_endurance_pump', text: 'I rarely fall pumped on routes at my level.', domain: 'power_endurance' },
  { id: 'recovery_between_attempts', text: 'I recover well between hard sections/attempts.', domain: 'power_endurance' },
  { id: 'style_vertical', text: 'I climb well on vertical terrain.', domain: 'technique_transfer' },
  { id: 'style_steep', text: 'I climb well on steep terrain.', domain: 'core' },
  { id: 'style_slab', text: 'I climb well on slabs.', domain: 'technique_transfer' },
  { id: 'confidence_limit_moves', text: 'I commit fully to limit moves.', domain: 'power' },
  { id: 'reading_tactics', text: 'I read routes and plan tactics well.', domain: 'strength_area' },
  { id: 'resting', text: 'I find and use rests efficiently.', domain: 'strength_area' },
];

/** Defaults: reading/tactics/resting rated as strengths. */
export const QUESTIONNAIRE_DEFAULTS: Partial<Record<QuestionId, 1 | 2 | 3 | 4 | 5>> = { reading_tactics: 5, resting: 5 };

export interface DomainScore {
  domain: Domain;
  label: string;
  score: number;
  components: { tests: number | null; questionnaire: number | null; logs: number | null };
  confidence: 'low' | 'medium' | 'high';
  notes: string[];
}

export interface WeaknessRanking {
  date: ISODate;
  goalGrade: string;
  /** Weakest first. */
  ranked: DomainScore[];
  top: Domain[];
  caveat: string;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const round = (x: number) => Math.round(x);

/** Epley: 1RM total = total x (1 + reps/30). Returns ADDED kg at 1RM. (coaching practice formula) */
export function estimate1RMAdded(addedKg: number, reps: number, bodyMassKg: number): number {
  if (reps <= 1) return addedKg;
  const total = (bodyMassKg + addedKg) * (1 + reps / 30);
  return Math.round((total - bodyMassKg) * 10) / 10;
}

/** Interpolated norms for a French sport grade (clamped to the table range). */
export function normsFor(grade: string, n: Norms = defaultNorms): GradeNorm {
  const keys = Object.keys(n.bySportGrade).sort((a, b) => sportIndex(a) - sportIndex(b));
  const gi = sportIndex(grade);
  if (gi < 0) return n.bySportGrade[keys[0]];
  const idx = keys.map(sportIndex);
  if (gi <= idx[0]) return n.bySportGrade[keys[0]];
  if (gi >= idx[idx.length - 1]) return n.bySportGrade[keys[keys.length - 1]];
  const exact = keys.find((k) => sportIndex(k) === gi);
  if (exact) return n.bySportGrade[exact];
  const hiI = idx.findIndex((i) => i > gi);
  const lo = n.bySportGrade[keys[hiI - 1]];
  const hi = n.bySportGrade[keys[hiI]];
  const t = (gi - idx[hiI - 1]) / (idx[hiI] - idx[hiI - 1]);
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return {
    maxHangTotalPctBW: lerp(lo.maxHangTotalPctBW, hi.maxHangTotalPctBW),
    pullup1RMAddedPctBW: lerp(lo.pullup1RMAddedPctBW, hi.pullup1RMAddedPctBW),
    lockoffS: lerp(lo.lockoffS, hi.lockoffS),
    frontLeverLevel: lerp(lo.frontLeverLevel, hi.frontLeverLevel),
    repeatersRemovedPctBW: lerp(lo.repeatersRemovedPctBW, hi.repeatersRemovedPctBW),
  };
}

/** ratio 1.0 (= at goal norm) -> 70; each 10 % below/above -> -/+ 15 points. */
const ratioScore = (ratio: number) => clamp(70 + (ratio - 1) * 150);

function testScores(profile: ProfileEntry, benchmarks: BenchmarkResult[], n: Norms): Partial<Record<Domain, { score: number; note: string }>> {
  const goal = normsFor(profile.goal.grade, n);
  const bm = profile.bodyMassKg;
  const latest = latestBenchmarks(benchmarks);
  const out: Partial<Record<Domain, { score: number; note: string }>> = {};

  const hang = benchmarkValue(latest, 'max_hang_20mm_10s_hc');
  if (hang !== null) {
    const pct = ((bm + hang) / bm) * 100;
    out.finger_strength = { score: ratioScore(pct / goal.maxHangTotalPctBW), note: `Max hang ${round(pct)} % BW vs indicative ${round(goal.maxHangTotalPctBW)} % for ${profile.goal.grade}.` };
  }
  const pull = latest.get('weighted_pullup');
  if (pull) {
    const added1RM = estimate1RMAdded(pull.value, pull.reps ?? 1, pull.bodyMassKg || bm);
    const pct = (added1RM / bm) * 100;
    const lock = benchmarkValue(latest, 'max_lockoff');
    let s = ratioScore((pct + 100) / (goal.pullup1RMAddedPctBW + 100));
    if (lock !== null) s = (s + ratioScore(lock / goal.lockoffS)) / 2;
    out.pull_strength = { score: s, note: `Pull-up 1RM +${round(pct)} % BW vs indicative +${round(goal.pullup1RMAddedPctBW)} %.` };
  }
  const fl = latest.get('front_lever');
  if (fl) {
    const lvl = fl.value;
    out.core = { score: clamp(70 + (lvl - goal.frontLeverLevel) * 15), note: `Front lever: ${FRONT_LEVER_LEVELS[Math.max(0, Math.min(5, Math.round(lvl)))]}.` };
  }
  const rep = latest.get('repeaters_7_3_20mm');
  if (rep) {
    const removedPct = (rep.value / bm) * 100;
    // Less assistance than the norm = stronger. 5 %BW difference ~ 15 points.
    out.power_endurance = { score: clamp(70 + (goal.repeatersRemovedPctBW - removedPct) * 3), note: `Repeaters with ${round(removedPct)} % BW removed (indicative ${round(goal.repeatersRemovedPctBW)} %).` };
  }
  const board = latest.get('power_board_max_move');
  if (board?.gradeText) {
    const d = gradeDelta(board.gradeText, profile.gradeBoulderBoard, 'boulder');
    if (d !== null) out.power = { score: clamp(60 + d * 10), note: `Board max ${board.gradeText}.` };
  }
  return out;
}

function questionnaireScores(q: QuestionnaireResponse | undefined): Partial<Record<Domain, number>> {
  if (!q) return {};
  const answers = { ...QUESTIONNAIRE_DEFAULTS, ...q.answers };
  const acc: Partial<Record<Domain, number[]>> = {};
  for (const item of QUESTIONS) {
    if (item.domain === 'strength_area') continue;
    const a = answers[item.id];
    if (a === undefined) continue;
    (acc[item.domain] ??= []).push(((a - 1) / 4) * 100);
  }
  const out: Partial<Record<Domain, number>> = {};
  for (const [d, xs] of Object.entries(acc)) out[d as Domain] = xs!.reduce((s, x) => s + x, 0) / xs!.length;
  return out;
}

function logScores(profile: ProfileEntry, climbs: ClimbLog[], benchmarks: BenchmarkResult[], asOf: ISODate, n: Norms): Partial<Record<Domain, { score: number; note: string }>> {
  const out: Partial<Record<Domain, { score: number; note: string }>> = {};
  // Technique / transfer: board vs outdoor boulder gap (profile grades, refined by logged sends).
  const from = addDays(asOf, -120);
  const recent = climbs.filter((c) => !c.deleted && c.date >= from && c.discipline === 'boulder' && c.style !== 'attempt');
  const best = (pred: (c: ClimbLog) => boolean) =>
    recent.filter(pred).reduce<string | null>((m, c) => (m === null || fontIndex(c.grade) > fontIndex(m) ? c.grade : m), null);
  const boardBest = best((c) => c.setting === 'board') ?? profile.gradeBoulderBoard;
  const outBest = best((c) => c.setting === 'outdoor') ?? profile.gradeBoulderOutdoor;
  const gap = gradeDelta(boardBest, outBest, 'boulder');
  if (gap !== null) {
    const excess = gap - n.transfer.expectedBoardMinusOutdoor;
    out.technique_transfer = {
      score: clamp(70 - excess * 12),
      note: `Board ${boardBest} vs outdoor ${outBest}: gap of ${gap} sub-grades${gap >= n.transfer.weakAtGap ? ' — suggests a technique / style-transfer weakness (to confirm)' : ''}.`,
    };
  }
  // Finger strength trend: last two max-hang results.
  const hangs = benchmarks.filter((b) => !b.deleted && b.type === 'max_hang_20mm_10s_hc').sort((a, b) => a.date.localeCompare(b.date));
  if (hangs.length >= 2) {
    const a = hangs[hangs.length - 2];
    const b = hangs[hangs.length - 1];
    const ch = ((b.bodyMassKg + b.value) / (a.bodyMassKg + a.value) - 1) * 100;
    out.finger_strength = { score: clamp(60 + ch * 5), note: `Max hang trend ${ch >= 0 ? '+' : ''}${ch.toFixed(1)} % since ${a.date}.` };
  }
  // Route level vs goal (power endurance proxy): best recent redpoint.
  const routes = climbs.filter((c) => !c.deleted && c.discipline === 'route' && c.date >= from && (c.style === 'redpoint' || c.style === 'flash' || c.style === 'onsight'));
  if (routes.length) {
    const bestRoute = routes.reduce((m, c) => (sportIndex(c.grade) > sportIndex(m.grade) ? c : m));
    const d = gradeDelta(bestRoute.grade, profile.goal.grade, 'route');
    if (d !== null) out.power_endurance = { score: clamp(70 + d * 8), note: `Best recent route ${bestRoute.grade}.` };
  }
  return out;
}

export function rankWeaknesses(
  profile: ProfileEntry,
  benchmarks: BenchmarkResult[],
  questionnaire: QuestionnaireResponse | undefined,
  climbs: ClimbLog[],
  asOf: ISODate,
  n: Norms = defaultNorms,
): WeaknessRanking {
  const t = testScores(profile, benchmarks, n);
  const q = questionnaireScores(questionnaire);
  const l = logScores(profile, climbs, benchmarks, asOf, n);
  const domains = Object.keys(DOMAIN_LABELS) as Domain[];
  // Suspected weaknesses from the profile act as a weak prior when nothing else is known.
  const suspected = new Set(profile.suspectedWeaknesses.map((s) => (s === 'technique_outdoor_transfer' || s === 'technique' ? 'technique_transfer' : s)));

  const ranked: DomainScore[] = domains.map((d) => {
    const parts: [number | null, number][] = [
      [t[d]?.score ?? null, 0.5],
      [q[d] ?? null, 0.3],
      [l[d]?.score ?? null, 0.2],
    ];
    const present = parts.filter(([v]) => v !== null) as [number, number][];
    const wsum = present.reduce((s, [, w]) => s + w, 0);
    let score = present.length ? present.reduce((s, [v, w]) => s + v * w, 0) / wsum : 60;
    const notes = [t[d]?.note, l[d]?.note].filter((x): x is string => !!x);
    if (!present.length && suspected.has(d)) {
      score = 45;
      notes.push('Suspected weakness (from profile) — confirm with tests.');
    }
    return {
      domain: d,
      label: DOMAIN_LABELS[d],
      score: round(score),
      components: { tests: t[d] ? round(t[d]!.score) : null, questionnaire: q[d] !== undefined ? round(q[d]!) : null, logs: l[d] ? round(l[d]!.score) : null },
      confidence: present.length >= 2 ? (present.length === 3 ? 'high' : 'medium') : 'low',
      notes,
    };
  });
  // Weakest first; ties broken by profile suspicion, then a fixed priority favouring the stated focus.
  const prio: Domain[] = ['finger_strength', 'power', 'technique_transfer', 'power_endurance', 'pull_strength', 'core'];
  ranked.sort((a, b) => a.score - b.score || Number(suspected.has(b.domain)) - Number(suspected.has(a.domain)) || prio.indexOf(a.domain) - prio.indexOf(b.domain));
  return {
    date: asOf,
    goalGrade: profile.goal.grade,
    ranked,
    top: ranked.slice(0, 3).map((r) => r.domain),
    caveat: n.caveat,
  };
}

export { SPORT_GRADES };
