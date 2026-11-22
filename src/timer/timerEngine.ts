/**
 * TIMER ENGINE — pure, clock-injected state machine (no DOM, fully unit-tested).
 *
 * A TimerPattern (exercises.json / PlannedItem.timer) is expanded into a list of phases:
 *   prepare -> [work -> rest]* per set -> setRest between sets -> done
 * Supported kinds: hang, repeaters (e.g. 7:3), isometric, interval, emom, four_by_four,
 * arc / countdown (single long work phase), reps (manual: work phase ends on user tap).
 *
 * The UI calls tick(now) from requestAnimationFrame / setInterval and reacts to events
 * (beeps, voice countdown, vibration, colour, quick set input). Wall-clock based, so the
 * timer stays exact even if the browser throttles ticks.
 */
import type { TimerPattern } from '../data/schema';

export type PhaseKind = 'prepare' | 'work' | 'rest' | 'setRest' | 'done';

export interface Phase {
  kind: PhaseKind;
  /** Seconds; null = open-ended (manual "Done" tap, e.g. reps-based sets). */
  durationS: number | null;
  setIndex: number;
  repIndex: number;
  /** Last work phase of a set. */
  lastOfSet: boolean;
}

export type TimerEvent =
  | { type: 'phase_start'; phase: Phase; index: number }
  | { type: 'countdown'; secondsLeft: number; phase: Phase }
  | { type: 'set_complete'; setIndex: number }
  | { type: 'done' };

export interface TimerState {
  pattern: TimerPattern;
  phases: Phase[];
  index: number;
  /** ms timestamp when the current phase (re)started counting. */
  phaseStartMs: number;
  /** ms already elapsed in this phase before the last pause. */
  elapsedBeforeMs: number;
  paused: boolean;
  /** Countdown seconds already announced in the current phase. */
  announced: number[];
  /** Sets completed so far (indices). */
  completedSets: number[];
  countdownLastS: number;
}

export interface BuildOptions {
  prepareS?: number;
  countdownLastS?: number;
}

/** Number of work/rest cycles per set, per kind. */
function phasesForSet(p: TimerPattern, setIndex: number): Phase[] {
  const out: Phase[] = [];
  const kind = p.kind;
  if (kind === 'arc' || kind === 'countdown') {
    out.push({ kind: 'work', durationS: p.totalS ?? p.workS ?? 0, setIndex, repIndex: 0, lastOfSet: true });
    return out;
  }
  if (kind === 'reps' || kind === 'none') {
    out.push({ kind: 'work', durationS: null, setIndex, repIndex: 0, lastOfSet: true });
    return out;
  }
  const reps = Math.max(1, p.reps);
  for (let r = 0; r < reps; r++) {
    const last = r === reps - 1;
    out.push({ kind: 'work', durationS: p.workS, setIndex, repIndex: r, lastOfSet: last });
    if (!last && p.restS > 0) out.push({ kind: 'rest', durationS: p.restS, setIndex, repIndex: r, lastOfSet: false });
  }
  return out;
}

export function buildPhases(p: TimerPattern, opts: BuildOptions = {}): Phase[] {
  const sets = Math.max(1, p.sets);
  const phases: Phase[] = [];
  const prepare = opts.prepareS ?? 5;
  if (prepare > 0) phases.push({ kind: 'prepare', durationS: prepare, setIndex: 0, repIndex: 0, lastOfSet: false });
  for (let s = 0; s < sets; s++) {
    phases.push(...phasesForSet(p, s));
    if (s < sets - 1 && p.setRestS > 0) phases.push({ kind: 'setRest', durationS: p.setRestS, setIndex: s, repIndex: 0, lastOfSet: false });
  }
  phases.push({ kind: 'done', durationS: 0, setIndex: sets - 1, repIndex: 0, lastOfSet: false });
  return phases;
}

export function createTimer(pattern: TimerPattern, now: number, opts: BuildOptions = {}): { state: TimerState; events: TimerEvent[] } {
  const phases = buildPhases(pattern, opts);
  const state: TimerState = {
    pattern,
    phases,
    index: 0,
    phaseStartMs: now,
    elapsedBeforeMs: 0,
    paused: false,
    announced: [],
    completedSets: [],
    countdownLastS: opts.countdownLastS ?? 3,
  };
  return { state, events: [{ type: 'phase_start', phase: phases[0], index: 0 }] };
}

export function currentPhase(s: TimerState): Phase {
  return s.phases[s.index];
}

export function elapsedMs(s: TimerState, now: number): number {
  return s.elapsedBeforeMs + (s.paused ? 0 : Math.max(0, now - s.phaseStartMs));
}

/** Remaining seconds (float) in the current phase; null for open-ended phases. */
export function remainingS(s: TimerState, now: number): number | null {
  const ph = currentPhase(s);
  if (ph.durationS === null) return null;
  return Math.max(0, ph.durationS - elapsedMs(s, now) / 1000);
}

export function isDone(s: TimerState): boolean {
  return currentPhase(s).kind === 'done';
}

/** Totals for the progress bar. */
export function progress(s: TimerState, now: number): { set: number; sets: number; rep: number; reps: number; fraction: number } {
  const ph = currentPhase(s);
  const sets = 1 + Math.max(...s.phases.map((p) => p.setIndex));
  const reps = s.phases.filter((p) => p.kind === 'work' && p.setIndex === ph.setIndex).length;
  const timed = s.phases.filter((p) => p.durationS !== null).reduce((a, p) => a + (p.durationS ?? 0), 0);
  const doneS = s.phases.slice(0, s.index).reduce((a, p) => a + (p.durationS ?? 0), 0) + (ph.durationS !== null ? elapsedMs(s, now) / 1000 : 0);
  return { set: ph.setIndex + 1, sets, rep: ph.repIndex + 1, reps, fraction: timed > 0 ? Math.min(1, doneS / timed) : 0 };
}

function enter(s: TimerState, index: number, startMs: number): { state: TimerState; events: TimerEvent[] } {
  const events: TimerEvent[] = [];
  const prev = s.phases[s.index];
  let completedSets = s.completedSets;
  if (prev.kind === 'work' && prev.lastOfSet && !completedSets.includes(prev.setIndex)) {
    completedSets = [...completedSets, prev.setIndex];
    events.push({ type: 'set_complete', setIndex: prev.setIndex });
  }
  const i = Math.min(index, s.phases.length - 1);
  const next: TimerState = { ...s, index: i, phaseStartMs: startMs, elapsedBeforeMs: 0, announced: [], completedSets };
  const ph = next.phases[i];
  events.push({ type: 'phase_start', phase: ph, index: i });
  if (ph.kind === 'done') events.push({ type: 'done' });
  return { state: next, events };
}

/**
 * Advance the clock. Handles several phase transitions in one call (after a long freeze),
 * carrying overshoot into the next phase so total timing stays exact.
 */
export function tick(state: TimerState, now: number): { state: TimerState; events: TimerEvent[] } {
  let s = state;
  const events: TimerEvent[] = [];
  if (s.paused || isDone(s)) return { state: s, events };
  for (let guard = 0; guard < 10_000; guard++) {
    const ph = currentPhase(s);
    if (ph.kind === 'done' || ph.durationS === null) break;
    const el = elapsedMs(s, now);
    const durMs = ph.durationS * 1000;
    // Countdown announcements for the last N seconds of work / rest / prepare phases.
    const left = Math.ceil((durMs - el) / 1000);
    if (left >= 1 && left <= s.countdownLastS && !s.announced.includes(left) && ph.durationS > s.countdownLastS) {
      s = { ...s, announced: [...s.announced, left] };
      events.push({ type: 'countdown', secondsLeft: left, phase: ph });
    }
    if (el < durMs) break;
    const overshoot = el - durMs;
    const r = enter(s, s.index + 1, now - overshoot);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

export function pause(s: TimerState, now: number): TimerState {
  if (s.paused) return s;
  return { ...s, paused: true, elapsedBeforeMs: elapsedMs(s, now) };
}

export function resume(s: TimerState, now: number): TimerState {
  if (!s.paused) return s;
  return { ...s, paused: false, phaseStartMs: now };
}

/** Skip the current phase (also used as the "Done" tap for open-ended rep sets). */
export function skip(s: TimerState, now: number): { state: TimerState; events: TimerEvent[] } {
  if (isDone(s)) return { state: s, events: [] };
  const r = enter(s, s.index + 1, now);
  return { state: { ...r.state, paused: false }, events: r.events };
}

/** Skip the rest of the current set (jump to the next set's first work phase or done). */
export function skipSet(s: TimerState, now: number): { state: TimerState; events: TimerEvent[] } {
  const cur = currentPhase(s);
  const target = s.phases.findIndex((p, i) => i > s.index && ((p.setIndex > cur.setIndex && p.kind === 'work') || p.kind === 'done'));
  const events: TimerEvent[] = [];
  let st = s;
  if (cur.kind === 'work' || cur.kind === 'rest') {
    // Mark the set complete (user ended it early, e.g. failure).
    if (!st.completedSets.includes(cur.setIndex)) {
      st = { ...st, completedSets: [...st.completedSets, cur.setIndex] };
      events.push({ type: 'set_complete', setIndex: cur.setIndex });
    }
  }
  // Go to the set-rest preceding the next set if present, else straight to the target.
  const setRest = s.phases.findIndex((p, i) => i > s.index && p.kind === 'setRest' && p.setIndex === cur.setIndex);
  const to = setRest >= 0 && cur.kind !== 'setRest' ? setRest : target;
  const ph = st.phases[to];
  const next: TimerState = { ...st, index: to, phaseStartMs: now, elapsedBeforeMs: 0, announced: [], paused: false };
  events.push({ type: 'phase_start', phase: ph, index: to });
  if (ph.kind === 'done') events.push({ type: 'done' });
  return { state: next, events };
}

/** Append one more set at the end (before "done"). */
export function addSet(s: TimerState): TimerState {
  const lastSet = Math.max(...s.phases.map((p) => p.setIndex));
  const newSet = lastSet + 1;
  const body = phasesForSet(s.pattern, newSet);
  const donePhase = s.phases[s.phases.length - 1];
  const before = s.phases.slice(0, -1);
  const rest: Phase[] = s.pattern.setRestS > 0 ? [{ kind: 'setRest', durationS: s.pattern.setRestS, setIndex: lastSet, repIndex: 0, lastOfSet: false }] : [];
  return {
    ...s,
    pattern: { ...s.pattern, sets: s.pattern.sets + 1 },
    phases: [...before, ...rest, ...body, { ...donePhase, setIndex: newSet }],
  };
}

/** Remove the last set if it has not started yet. Returns the state unchanged otherwise. */
export function removeSet(s: TimerState): TimerState {
  const lastSet = Math.max(...s.phases.map((p) => p.setIndex));
  const cur = currentPhase(s);
  if (lastSet === 0 || cur.setIndex >= lastSet) return s;
  const firstIdx = s.phases.findIndex((p) => p.kind === 'work' && p.setIndex === lastSet);
  if (firstIdx <= s.index) return s;
  // Also remove the set-rest before it.
  const cut = s.phases[firstIdx - 1]?.kind === 'setRest' ? firstIdx - 1 : firstIdx;
  const donePhase = s.phases[s.phases.length - 1];
  return {
    ...s,
    pattern: { ...s.pattern, sets: s.pattern.sets - 1 },
    phases: [...s.phases.slice(0, cut), { ...donePhase, setIndex: lastSet - 1 }],
  };
}

/** Total planned duration in seconds (open-ended phases count as 0). */
export function totalDurationS(p: TimerPattern, opts: BuildOptions = {}): number {
  return buildPhases(p, opts).reduce((a, ph) => a + (ph.durationS ?? 0), 0);
}

/** Display helper: 75 -> "1:15", 9.2 -> "10" (ceil, seconds only under a minute). */
export function formatClock(seconds: number | null): string {
  if (seconds === null) return '—';
  const s = Math.ceil(seconds - 1e-9);
  if (s < 60) return String(s);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
