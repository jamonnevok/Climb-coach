/**
 * AUTO-PROGRESSION (proposal only).
 *  - all sets completed and mean RPE <= rpeProgressMax (8)  -> increase one step
 *  - completed, mean RPE <= rpeHoldMax (9)                  -> hold
 *  - a set failed (or RPE 10)                               -> hold; 2nd consecutive failure -> reduce failReducePct (5 %)
 * Finger loads: step = 2.5 % BW, and never more than maxFingerIncreasePctBWPerWeek per week.
 * Finger progression is BLOCKED when finger status is low or recent finger pain > 2/10.
 * "removed_kg" (assisted) progresses by REMOVING LESS assistance.
 */
import { rules as defaultRules, type Rules } from '../config';
import type { ExerciseDef, LoadMode, SetLog } from '../data/schema';

export type ProgressionAction = 'increase' | 'hold' | 'decrease' | 'none';

export interface ProgressionInput {
  exercise: ExerciseDef;
  /** Sets of the most recent session for this exercise. */
  lastSets: SetLog[];
  /** Whether the previous attempt (session before lastSets) also failed. */
  previousFailed: boolean;
  bodyMassKg: number;
  /** Planned/current prescription. */
  current: { mode: LoadMode; value: number | null };
  /** Total increase (kg) already applied this week to this exercise (cap tracking). */
  increaseThisWeekKg?: number;
  fingerStatusLow?: boolean;
  recentFingerPainMax?: number;
}

export interface ProgressionSuggestion {
  action: ProgressionAction;
  newValue: number | null;
  failed: boolean;
  reason: string;
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const isFinger = (e: ExerciseDef) => e.category === 'finger' || (e.category === 'prehab' && e.fingerIntensity !== 'none');

export function stepFor(ex: ExerciseDef, mode: LoadMode, bodyMassKg: number, r: Rules = defaultRules): number {
  const p = r.progression;
  if (mode === 'target_force_kg') return p.forceStepKg;
  if (isFinger(ex)) return Math.max(p.roundToKg, roundTo((p.fingerStepPctBW / 100) * bodyMassKg, p.roundToKg));
  return p.pullStepKg;
}

export function suggestProgression(input: ProgressionInput, r: Rules = defaultRules): ProgressionSuggestion {
  const { exercise: ex, lastSets, current } = input;
  const p = r.progression;
  const loadable: LoadMode[] = ['added_kg', 'removed_kg', 'target_force_kg', 'percent_bw'];
  if (!loadable.includes(current.mode) || current.value === null) {
    return { action: 'none', newValue: current.value, failed: false, reason: 'Not load-based, or no load set yet (run the test first).' };
  }
  if (!lastSets.length) return { action: 'none', newValue: current.value, failed: false, reason: 'No logged sets yet.' };

  const failed = lastSets.some((s) => !s.completed) || lastSets.some((s) => (s.rpe ?? 0) >= 10);
  const rpes = lastSets.map((s) => s.rpe).filter((x): x is number => typeof x === 'number');
  const meanRpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
  const step = stepFor(ex, current.mode, input.bodyMassKg, r);
  // Sign: +step means "harder". For removed_kg, harder = less assistance (value decreases).
  const dir = current.mode === 'removed_kg' ? -1 : 1;
  const pctStep = current.mode === 'percent_bw' ? p.fingerStepPctBW : null;

  if (failed) {
    if (input.previousFailed) {
      const reduceKg = current.mode === 'percent_bw' ? p.failReducePct : roundTo(((input.bodyMassKg + (current.mode === 'added_kg' ? current.value : 0)) * p.failReducePct) / 100, p.roundToKg);
      const nv = current.mode === 'removed_kg' ? current.value + reduceKg : current.value - reduceKg;
      return { action: 'decrease', newValue: Math.round(nv * 10) / 10, failed: true, reason: `Second consecutive failed session: reduce by ${p.failReducePct} %.` };
    }
    return { action: 'hold', newValue: current.value, failed: true, reason: 'A set was not completed: hold the load and retry.' };
  }

  if (isFinger(ex)) {
    if (input.fingerStatusLow) return { action: 'hold', newValue: current.value, failed: false, reason: 'Finger status low: no finger progression.' };
    if ((input.recentFingerPainMax ?? 0) > r.pain.continueMax) {
      return { action: 'hold', newValue: current.value, failed: false, reason: `Recent finger pain ${input.recentFingerPainMax}/10: no finger progression.` };
    }
  }

  if (meanRpe === null) return { action: 'hold', newValue: current.value, failed: false, reason: 'No RPE logged: hold (log RPE to enable progression).' };
  if (meanRpe > p.rpeHoldMax) return { action: 'hold', newValue: current.value, failed: false, reason: `Mean RPE ${meanRpe.toFixed(1)}: hold.` };
  if (meanRpe > p.rpeProgressMax) return { action: 'hold', newValue: current.value, failed: false, reason: `Mean RPE ${meanRpe.toFixed(1)}: hold until ≤ ${p.rpeProgressMax}.` };

  let inc = pctStep ?? step;
  if (isFinger(ex) && current.mode !== 'percent_bw') {
    const weeklyCapKg = roundTo((p.maxFingerIncreasePctBWPerWeek / 100) * input.bodyMassKg, p.roundToKg);
    const room = weeklyCapKg - (input.increaseThisWeekKg ?? 0);
    if (room <= 0) return { action: 'hold', newValue: current.value, failed: false, reason: 'Weekly finger-load increase cap reached.' };
    inc = Math.min(inc, room);
  }
  let nv = current.value + dir * inc;
  if (current.mode === 'removed_kg') nv = Math.max(0, nv);
  nv = Math.round(nv * 10) / 10;
  return { action: 'increase', newValue: nv, failed: false, reason: `All sets done at mean RPE ${meanRpe.toFixed(1)} ≤ ${p.rpeProgressMax}: ${dir > 0 ? '+' : '−'}${inc}${current.mode === 'percent_bw' ? ' % BW' : ' kg'}.` };
}

/** Group a session's sets by exercise. */
export function setsByExercise(sets: SetLog[]): Map<string, SetLog[]> {
  const m = new Map<string, SetLog[]>();
  for (const s of sets) (m.get(s.exerciseId) ?? m.set(s.exerciseId, []).get(s.exerciseId)!).push(s);
  return m;
}
