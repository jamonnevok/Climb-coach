import { describe, expect, it } from 'vitest';
import {
  addSet,
  buildPhases,
  createTimer,
  currentPhase,
  formatClock,
  isDone,
  pause,
  progress,
  remainingS,
  removeSet,
  resume,
  skip,
  skipSet,
  tick,
  totalDurationS,
  type TimerEvent,
  type TimerState,
} from '../src/timer/timerEngine';
import { changeSetCount, finish, isFinished, itemComplete, next, recordSet, skipItem, startGuided } from '../src/timer/guidedSession';
import type { PlannedSession, TimerPattern } from '../src/data/schema';

const repeaters: TimerPattern = { kind: 'repeaters', sets: 2, reps: 3, workS: 7, restS: 3, setRestS: 60 };
const hangs: TimerPattern = { kind: 'hang', sets: 3, reps: 1, workS: 10, restS: 0, setRestS: 180 };

function run(state: TimerState, from: number, to: number, step = 100) {
  const events: TimerEvent[] = [];
  let s = state;
  for (let t = from; t <= to; t += step) {
    const r = tick(s, t);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

describe('phase building', () => {
  it('repeaters 2x(3 x 7:3) with 60 s set rest and 5 s prepare', () => {
    const ph = buildPhases(repeaters, { prepareS: 5 });
    expect(ph.map((p) => p.kind).join(',')).toBe('prepare,work,rest,work,rest,work,setRest,work,rest,work,rest,work,done');
    expect(totalDurationS(repeaters, { prepareS: 5 })).toBe(5 + 2 * (21 + 6) + 60);
  });
  it('max hangs: no intra-set rest, set rest between sets', () => {
    expect(buildPhases(hangs, { prepareS: 0 }).map((p) => p.kind).join(',')).toBe('work,setRest,work,setRest,work,done');
  });
  it('ARC / countdown: one long work phase; reps-based: open-ended work', () => {
    expect(buildPhases({ kind: 'arc', sets: 1, reps: 1, workS: 0, restS: 0, setRestS: 0, totalS: 1200 }, { prepareS: 0 })[0].durationS).toBe(1200);
    expect(buildPhases({ kind: 'reps', sets: 2, reps: 5, workS: 3, restS: 0, setRestS: 90 }, { prepareS: 0 })[0].durationS).toBeNull();
  });
  it('EMOM and 4x4 expand to work/rest cycles', () => {
    const emom = buildPhases({ kind: 'emom', sets: 1, reps: 8, workS: 40, restS: 20, setRestS: 0, totalS: 480 }, { prepareS: 0 });
    expect(emom.filter((p) => p.kind === 'work')).toHaveLength(8);
    const fxf = buildPhases({ kind: 'four_by_four', sets: 4, reps: 4, workS: 45, restS: 0, setRestS: 240 }, { prepareS: 0 });
    expect(fxf.filter((p) => p.kind === 'rest')).toHaveLength(0);
    expect(fxf.filter((p) => p.kind === 'setRest')).toHaveLength(3);
  });
});

describe('ticking', () => {
  it('runs a full repeater block with exact timing, countdowns and set events', () => {
    const { state } = createTimer(repeaters, 0, { prepareS: 5 });
    const end = totalDurationS(repeaters, { prepareS: 5 }) * 1000;
    const r = run(state, 0, end + 200);
    expect(isDone(r.state)).toBe(true);
    const sets = r.events.filter((e) => e.type === 'set_complete').map((e) => (e as { setIndex: number }).setIndex);
    expect(sets).toEqual([0, 1]);
    // countdown 3-2-1 announced in phases longer than 3 s: prepare, 6 work, setRest = 8 phases
    const cd = r.events.filter((e) => e.type === 'countdown');
    expect(cd).toHaveLength(8 * 3);
    expect(r.events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('catches up after a long freeze (background tab) without losing time', () => {
    const { state } = createTimer(hangs, 0, { prepareS: 0 });
    const r = tick(state, 195_000); // 10 s work + 180 s rest + 5 s into set 2
    expect(currentPhase(r.state).setIndex).toBe(1);
    expect(currentPhase(r.state).kind).toBe('work');
    expect(Math.round(remainingS(r.state, 195_000)!)).toBe(5);
  });

  it('pause / resume freezes the clock', () => {
    let { state } = createTimer(hangs, 0, { prepareS: 0 });
    state = tick(state, 4000).state;
    state = pause(state, 4000);
    state = tick(state, 60_000).state;
    expect(Math.round(remainingS(state, 60_000)!)).toBe(6);
    state = resume(state, 60_000);
    expect(Math.round(remainingS(state, 62_000)!)).toBe(4);
  });

  it('skip, skip set, open-ended reps finished by tap', () => {
    let { state } = createTimer(hangs, 0, { prepareS: 0 });
    state = skip(state, 1000).state;
    expect(currentPhase(state).kind).toBe('setRest');
    state = skip(state, 2000).state;
    expect(currentPhase(state).setIndex).toBe(1);
    const ss = skipSet(state, 3000);
    expect(ss.events.some((e) => e.type === 'set_complete')).toBe(true);
    expect(currentPhase(ss.state).kind).toBe('setRest');

    let reps = createTimer({ kind: 'reps', sets: 1, reps: 5, workS: 3, restS: 0, setRestS: 0 }, 0, { prepareS: 0 }).state;
    reps = tick(reps, 999_999).state;
    expect(currentPhase(reps).kind).toBe('work');
    const done = skip(reps, 1_000_000);
    expect(done.events.some((e) => e.type === 'set_complete')).toBe(true);
    expect(isDone(done.state)).toBe(true);
  });

  it('add / remove a set on the fly', () => {
    let { state } = createTimer(hangs, 0, { prepareS: 0 });
    state = addSet(state);
    expect(state.phases.filter((p) => p.kind === 'work')).toHaveLength(4);
    expect(progress(state, 0).sets).toBe(4);
    state = removeSet(removeSet(state));
    expect(state.phases.filter((p) => p.kind === 'work')).toHaveLength(2);
    expect(state.phases[state.phases.length - 1].kind).toBe('done');
    // cannot remove the set in progress
    state = skip(skip(state, 0).state, 0).state; // now in set 2 (last)
    expect(removeSet(state).phases).toHaveLength(state.phases.length);
  });

  it('formats the clock', () => {
    expect(formatClock(9.2)).toBe('10');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(null)).toBe('—');
  });
});

describe('guided session', () => {
  const session: PlannedSession = {
    id: 'ps', date: '2026-11-24', kind: 'training', title: 'Fingers', estDurationMin: 60, estSessionRPE: 8, fingerIntensity: 'max',
    estFingerLoad: 10, location: 'home', status: 'planned',
    items: [
      { id: 'i1', exerciseId: 'max_hang_20_hc', role: 'main', timer: hangs, load: { mode: 'added_kg', value: 10 }, grip: 'half_crimp', edgeMm: 20 },
      { id: 'i2', exerciseId: 'weighted_pullup', role: 'accessory', timer: { kind: 'reps', sets: 2, reps: 3, workS: 4, restS: 0, setRestS: 180 }, load: { mode: 'added_kg', value: 20 } },
    ],
  };

  it('records sets per item, supports extra sets, skip and finish', () => {
    let g = startGuided(session, new Date('2026-11-24T18:00:00Z'));
    g = recordSet(g, { completed: true, rpe: 7, fingerFeeling: 4 });
    g = recordSet(g, { completed: true, rpe: 8, loadValue: 11 });
    expect(itemComplete(g)).toBe(false);
    g = changeSetCount(g, -1);
    expect(itemComplete(g)).toBe(true);
    g = changeSetCount(g, -1); // cannot go below sets already done
    expect(itemComplete(g)).toBe(true);
    g = skipItem(next(g));
    expect(isFinished(g)).toBe(true);
    const log = finish(g, { sessionRPE: 8 }, new Date('2026-11-24T18:42:00Z'));
    expect(log.durationMin).toBe(42);
    expect(log.sets).toHaveLength(2);
    expect(log.sets[1].load.value).toBe(11);
    expect(log.sets[0].reps).toBe(1);
    expect(log.plannedSessionId).toBe('ps');
    expect(log.notes).toBe('Skipped 1 item(s).');
  });
});
