import { describe, expect, it } from 'vitest';
import { exerciseLibrary, planTemplates, references } from '../src/config';
import { addDays, diffDays, weekdayIndex } from '../src/lib/dates';
import { buildLibrary } from '../src/engine/library';
import {
  assignDays,
  buildMacro,
  generatePlan,
  insertPhases,
  planStartDate,
  prescribeLoad,
  rxContext,
} from '../src/engine/planGenerator';
import { checkRules } from '../src/engine/planRules';
import { BENCHMARKS, genInput, profile, settings, TODAY } from './fixtures';
import type { PlannedSession } from '../src/data/schema';

const lib = buildLibrary();
const mainSessions = (ss: PlannedSession[]) => ss.filter((s) => s.kind !== 'prehab' && !s.optional);

describe('config integrity', () => {
  it('every template references an existing exercise and every reference id exists', () => {
    const ids = new Set(exerciseLibrary.map((e) => e.id));
    const walk = (x: unknown): string[] =>
      Array.isArray(x) ? x.flatMap(walk) : x && typeof x === 'object' ? [...('ex' in (x as object) ? [(x as { ex: string }).ex] : []), ...Object.values(x as object).flatMap(walk)] : [];
    const missing = walk(planTemplates).filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
    const badRefs = exerciseLibrary.flatMap((e) => e.references.filter((r) => !references[r]));
    expect(badRefs).toEqual([]);
  });

  it('exercises without references are labelled coaching practice or experimental', () => {
    const bad = exerciseLibrary.filter((e) => e.references.length === 0 && e.evidence === 'research');
    expect(bad.map((e) => e.id)).toEqual([]);
  });
});

describe('macro', () => {
  it('starts this Monday early in the week, next Monday otherwise', () => {
    expect(planStartDate('2026-11-24')).toBe('2026-11-23');
    expect(planStartDate('2026-11-27')).toBe('2026-11-30');
  });

  it('default: strength 5 -> power 4 -> performance 5, deload last week, ~26 weeks', () => {
    const m = buildMacro({ start: '2026-11-23', targetDate: null, mode: 'normal', phases: [], focus: [] });
    expect(m.slice(0, 3).map((b) => [b.kind, b.weeks])).toEqual([['strength', 5], ['power', 4], ['performance', 5]]);
    expect(m[0].deloadWeekIndex).toBe(4);
    expect(m.reduce((s, b) => s + b.weeks, 0)).toBe(26);
    for (let i = 1; i < m.length; i++) expect(m[i].startDate).toBe(addDays(m[i - 1].startDate, m[i - 1].weeks * 7));
  });

  it('target date: built backwards with taper last and covering exactly the horizon', () => {
    const m = buildMacro({ start: '2026-11-23', targetDate: '2027-06-19', mode: 'normal', phases: [], focus: [] });
    expect(m[m.length - 1].kind).toBe('taper');
    expect(m[m.length - 2].kind).toBe('performance');
    const end = addDays(m[m.length - 1].startDate, m[m.length - 1].weeks * 7);
    expect(diffDays('2027-06-19', end) > 0 && diffDays('2027-06-19', end) <= 7).toBe(true);
    expect(m.every((b) => b.weeks <= 6)).toBe(true);
  });

  it('a projecting phase overwrites the weeks it covers and splits blocks', () => {
    const base = buildMacro({ start: '2026-11-23', targetDate: null, mode: 'normal', phases: [], focus: [] });
    const m = insertPhases(base, [{ kind: 'projecting', start: '2026-12-21', weeks: 3 }], []);
    const proj = m.find((b) => b.kind === 'projecting')!;
    expect(proj.startDate).toBe('2026-12-21');
    expect(proj.userInserted).toBe(true);
    expect(m[0].kind).toBe('strength');
    expect(m[0].weeks).toBe(4); // truncated head
    for (let i = 1; i < m.length; i++) expect(m[i].startDate >= addDays(m[i - 1].startDate, m[i - 1].weeks * 7)).toBe(true);
  });

  it('newborn mode = rolling newborn blocks; return ramp first when coming back', () => {
    const nb = buildMacro({ start: '2027-03-15', targetDate: null, mode: 'newborn', phases: [], focus: [] });
    expect(nb.every((b) => b.kind === 'newborn')).toBe(true);
    const rr = buildMacro({ start: '2027-06-07', targetDate: null, mode: 'return_ramp', phases: [], focus: [] });
    expect([rr[0].kind, rr[0].weeks, rr[1].kind]).toEqual(['return_ramp', 3, 'strength']);
  });
});

describe('prescriptions', () => {
  const rx = rxContext(profile(), BENCHMARKS);
  const ex = (id: string) => lib.get(id)!;
  it('max hang = % of (BM + max) − BM, rounded to 0.5 kg', () => {
    // ref 96 kg: 0.88 -> 84.48 - 74 = 10.48 -> 10.5
    expect(prescribeLoad('max_hang', ex('max_hang_20_hc'), rx, 0.88, 1).value).toBe(10.5);
    // deload -15 %: 96 * 0.88 * 0.85 - 74 = -2.2 -> -2 (assisted)
    expect(prescribeLoad('max_hang', ex('max_hang_20_hc'), rx, 0.88, 0.85).value).toBe(-2);
  });
  it('pull-ups from Epley 1RM; repeaters keep a margin of assistance', () => {
    // 3RM +25: 1RM total = 99 * 1.1 = 108.9 ; x 0.87 = 94.74 - 74 = 20.74 -> 20.5
    expect(prescribeLoad('pullup', ex('weighted_pullup'), rx, 1, 1).value).toBe(20.5);
    // test removed 15 kg + 5 % BW (3.7) = 18.7 -> 18.5
    expect(prescribeLoad('repeaters', ex('repeaters_7_3'), rx, 1, 1).value).toBe(18.5);
  });
  it('without benchmarks, loads are null with a note', () => {
    const empty = rxContext(profile(), []);
    const p = prescribeLoad('max_hang', ex('max_hang_20_hc'), empty, 0.9, 1);
    expect(p.value).toBeNull();
    expect(typeof p.note).toBe('string');
  });
});

describe('day scheduler', () => {
  it('never puts high-finger sessions back to back and honours preferred days', () => {
    const days = assignDays(
      [{ fingerIntensity: 'max' }, { fingerIntensity: 'moderate' }, { fingerIntensity: 'high' }],
      [0, 1, 2, 3, 4, 5, 6], [1, 3, 5], [], false,
    )!;
    expect([...days].sort()).toEqual([1, 3, 5]);
  });
  it('returns null when impossible', () => {
    expect(assignDays([{ fingerIntensity: 'max' }, { fingerIntensity: 'max' }], [2, 3], [], [], false)).toBeNull();
  });
  it('respects the previous week ending with a high day', () => {
    const d = assignDays([{ fingerIntensity: 'max' }], [0, 2], [0], [], true)!;
    expect(d).toEqual([2]);
  });
});

describe('generatePlan — example first block for the owner', () => {
  const plan = generatePlan(genInput());
  const all = plan.weeks.flatMap((w) => w.sessions);

  it('details the first (strength) block, 5 weeks, deload + re-test in week 5', () => {
    expect(plan.macro[0].kind).toBe('strength');
    expect(plan.weeks).toHaveLength(5);
    expect(plan.weeks[4].isDeload).toBe(true);
    expect(plan.weeks[4].sessions.some((s) => s.kind === 'test')).toBe(true);
    expect(plan.weeks[0].sessions.some((s) => s.kind === 'test')).toBe(false); // benchmarks exist
  });

  it('3 main sessions + 2 prehab slots per week on Tue/Thu/Sat by default', () => {
    for (const w of plan.weeks) {
      expect(mainSessions(w.sessions)).toHaveLength(3);
      expect(w.sessions.filter((s) => s.kind === 'prehab')).toHaveLength(2);
    }
    expect(mainSessions(plan.weeks[0].sessions).map((s) => weekdayIndex(s.date))).toEqual([1, 3, 5]);
  });

  it('respects every recovery rule across the whole block (incl. week boundaries)', () => {
    expect(checkRules(all)).toEqual([]);
  });

  it('prehab is never on a max-finger day', () => {
    const maxDays = new Set(all.filter((s) => s.fingerIntensity === 'max').map((s) => s.date));
    expect(all.filter((s) => s.kind === 'prehab' && maxDays.has(s.date))).toHaveLength(0);
  });

  it('auto-inserts a finger warm-up before finger work, and a cool-down at the end', () => {
    for (const s of mainSessions(all)) {
      const roles = s.items.map((i) => i.role);
      expect(roles[roles.length - 1]).toBe('cooldown');
      const firstFinger = s.items.findIndex((i) => ['max_hang_20_hc', 'nohang_lift', 'test_max_hang', 'board_power_moves'].includes(i.exerciseId));
      if (firstFinger >= 0) {
        const wu = s.items.findIndex((i) => i.exerciseId === 'finger_warmup_ramp');
        expect(wu >= 0 && wu < firstFinger).toBe(true);
      }
    }
  });

  it('progresses max-hang intensity across weeks 1-4, lower in deload', () => {
    const mh = plan.weeks.map((w) => w.sessions.flatMap((s) => s.items).find((i) => i.exerciseId === 'max_hang_20_hc')?.load.value ?? null);
    expect(mh[0]! < mh[1]! && mh[1]! < mh[2]! && mh[2]! < mh[3]!).toBe(true);
  });

  it('pockets appear only from week 2 and stay within the restricted-grip cap', () => {
    const has = (i: number) => plan.weeks[i].sessions.some((s) => s.items.some((x) => x.exerciseId === 'pocket_hang_3f'));
    expect(has(0)).toBe(false);
    for (const w of plan.weeks) expect(w.caps!.estRestricted <= w.caps!.restricted + 0.05).toBe(true);
  });

  it('every week stays within its finger cap', () => {
    for (const w of plan.weeks) expect(w.caps!.estFinger <= w.caps!.finger + 0.05).toBe(true);
  });
});

describe('generatePlan — variants', () => {
  it('no benchmarks -> assessment sessions in week 1', () => {
    const p = generatePlan(genInput({}, []));
    const tests = p.weeks[0].sessions.filter((s) => s.kind === 'test').map((s) => s.title);
    expect(tests.length).toBe(2);
  });

  it('outdoor day replaces a gym session and keeps rules', () => {
    const p = generatePlan(genInput({ overrides: { '2026-11-23': { outdoorDays: ['2026-11-29'] } } }));
    const w = p.weeks[0];
    expect(w.sessions.some((s) => s.date === '2026-11-29' && s.location === 'outdoor')).toBe(true);
    expect(mainSessions(w.sessions)).toHaveLength(3);
    expect(checkRules(w.sessions)).toEqual([]);
  });

  it('unavailable days are avoided; impossible weeks drop sessions with a note', () => {
    const p = generatePlan(genInput({}, BENCHMARKS, settings({ unavailableWeekdays: [0, 1, 2, 3, 4] })));
    const w = p.weeks[0];
    expect(w.sessions.every((s) => weekdayIndex(s.date) >= 5)).toBe(true);
    expect(checkRules(w.sessions)).toEqual([]);
    expect((w.notes ?? []).some((n) => n.includes('dropped'))).toBe(true);
  });

  it('newborn mode: 2 short home sessions + 1 optional bonus, no separate prehab', () => {
    const p = generatePlan(genInput({}, BENCHMARKS, settings({ mode: 'newborn' })));
    const w = p.weeks[0];
    const main = mainSessions(w.sessions);
    expect(main).toHaveLength(2);
    expect(main.every((s) => s.location === 'home' && s.estDurationMin <= 40)).toBe(true);
    expect(w.sessions.filter((s) => s.optional)).toHaveLength(1);
    expect(w.sessions.filter((s) => s.kind === 'prehab')).toHaveLength(0);
  });

  it('a tight finger cap trims the least important finger items first', () => {
    const p = generatePlan(genInput({}, BENCHMARKS, settings({ coldStart: { ...settings().coldStart!, fingerMinutesPerSession: 3, fingerIntensity: 'moderate' } })));
    const w = p.weeks[0];
    expect((w.notes ?? []).some((n) => n.startsWith('Finger-load cap'))).toBe(true);
    // max hangs (priority 1) survive
    expect(w.sessions.some((s) => s.items.some((i) => i.exerciseId === 'max_hang_20_hc'))).toBe(true);
  });

  it('version increments when regenerating from a previous plan and keeps projecting phases', () => {
    const first = generatePlan(genInput({ phases: [{ kind: 'projecting', start: '2027-01-04', weeks: 3 }] }));
    const second = generatePlan(genInput({ previous: first, today: TODAY }));
    expect(second.version).toBe(2);
    expect(second.id).toBe(first.id);
    expect(second.macro.some((b) => b.kind === 'projecting' && b.startDate === '2027-01-04')).toBe(true);
  });
});
