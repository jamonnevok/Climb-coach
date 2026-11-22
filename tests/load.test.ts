import { describe, expect, it } from 'vitest';
import {
  computeACWR,
  computeSessionLoads,
  edgeFactor,
  ewma,
  ewmaLambda,
  fingerCapsForWeek,
  fosterLoad,
  projectACWR,
  relativeIntensity,
  toDatedLoads,
  weekOnWeek,
  zoneFor,
  type DatedLoad,
  type ExerciseFingerInfo,
  type LoadContext,
} from '../src/engine/load';
import { addDays } from '../src/lib/dates';
import { gradeDelta, shiftGrade } from '../src/lib/grades';
import type { ClimbLog, ColdStartSeed, SessionLog, SetLog } from '../src/data/schema';

const EX: Record<string, ExerciseFingerInfo> = {
  max_hang: { category: 'finger', fingerIntensity: 'max', defaultGrip: 'half_crimp', edgeMm: 20 },
  pullup: { category: 'pull', fingerIntensity: 'none' },
  pocket_hang: { category: 'finger', fingerIntensity: 'high', defaultGrip: 'pocket_2f_middle', edgeMm: 20 },
};

const ctx: LoadContext = {
  bodyMassKg: 74,
  maxHangAddedKg: 26, // -> reference total 100 kg
  exercise: (id) => EX[id],
  grades: { sportRedpoint: '7b', boulderOutdoor: '6B', boulderBoard: '7A' },
};

const set = (p: Partial<SetLog>): SetLog => ({
  id: 's', exerciseId: 'max_hang', setIndex: 0, completed: true, reps: 1, workS: 10,
  load: { mode: 'added_kg', value: 26 }, at: '2026-11-21T10:00:00Z', ...p,
});

const session = (p: Partial<SessionLog>): SessionLog => ({
  id: 'x', createdAt: '', updatedAt: '', date: '2026-11-20', startedAt: null, kind: 'training', durationMin: 90,
  sessionRPE: 7, location: 'home', sets: [], globalLoad: 0, fingerLoad: 0, restrictedGripLoad: 0, source: 'manual', ...p,
});

const climb = (p: Partial<ClimbLog>): ClimbLog => ({
  id: 'c', createdAt: '', updatedAt: '', date: '2026-11-20', discipline: 'boulder', grade: '6B', style: 'attempt',
  angle: 'overhang', setting: 'outdoor', grips: ['half_crimp'], attempts: 5, ...p,
});

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b) < eps).toBe(true);

describe('Foster load', () => {
  it('is sRPE x duration, clamped', () => {
    expect(fosterLoad(7, 90)).toBe(630);
    expect(fosterLoad(12, 10)).toBe(100);
    expect(fosterLoad(5, -3)).toBe(0);
  });
});

describe('EWMA', () => {
  it('uses lambda = 2/(N+1)', () => {
    close(ewmaLambda(7), 0.25);
    close(ewmaLambda(28), 2 / 29);
  });
  it('matches a hand calculation', () => {
    const out = ewma([100, 0, 0], 7, 0);
    close(out[0], 25);
    close(out[1], 18.75);
    close(out[2], 14.0625);
  });
  it('a constant load at the seed level stays flat (ratio 1)', () => {
    const out = ewma([50, 50, 50, 50], 28, 50);
    out.forEach((v) => close(v, 50));
  });
});

describe('zones', () => {
  it('maps ratios to zones', () => {
    expect(zoneFor(null)).toBe('none');
    expect(zoneFor(0.7)).toBe('low');
    expect(zoneFor(1.0)).toBe('green');
    expect(zoneFor(1.3)).toBe('green');
    expect(zoneFor(1.4)).toBe('orange');
    expect(zoneFor(1.6)).toBe('red');
  });
});

describe('finger load index', () => {
  it('relative intensity vs reference max; one hand compared with half the max', () => {
    close(relativeIntensity({ mode: 'added_kg', value: 26 }, 'both', EX.max_hang, ctx), 1.0);
    close(relativeIntensity({ mode: 'removed_kg', value: 24 }, 'both', EX.max_hang, ctx), 0.5);
    close(relativeIntensity({ mode: 'target_force_kg', value: 40 }, 'left', EX.max_hang, ctx), 0.8);
    close(relativeIntensity({ mode: 'percent_bw', value: 0 }, 'both', EX.max_hang, ctx), 0.74);
  });

  it('smaller edges weigh more (sqrt rule, clamped)', () => {
    close(edgeFactor(20, {}), 1);
    close(edgeFactor(12, {}), Math.sqrt(20 / 12));
    close(edgeFactor(10, {}), 1.4); // sqrt(2) = 1.414 clamped
    close(edgeFactor(5, {}), 1.4);
    close(edgeFactor(40, {}), 0.8);
  });

  it('6 max hangs of 10 s at 100 % on 20 mm half crimp = 6 FLU, no restricted load', () => {
    const s = session({ sets: Array.from({ length: 6 }, (_, i) => set({ setIndex: i })) });
    const l = computeSessionLoads(s, [], ctx);
    expect(l.fingerLoad).toBe(6);
    expect(l.restrictedGripLoad).toBe(0);
    expect(l.globalLoad).toBe(630);
    expect(l.breakdown.climbing).toBe(0); // finger sets logged -> no kind-based fallback
  });

  it('non-finger exercises add nothing; restricted grips are tracked separately', () => {
    const s = session({
      sets: [set({ exerciseId: 'pullup', reps: 5, workS: 3 }), set({ exerciseId: 'pocket_hang', load: { mode: 'bodyweight', value: null } })],
    });
    const l = computeSessionLoads(s, [], ctx);
    // 10 s x 0.74 x 1.3 (2F middle) / 10 = 0.962
    expect(l.fingerLoad).toBe(1);
    expect(l.restrictedGripLoad).toBe(1);
  });

  it('climbing estimate from logged climbs uses grade-relative intensity', () => {
    // 6B outdoor = at max -> intensity 1.0; 5 attempts x 0.4 min = 120 s -> 12 FLU
    const l = computeSessionLoads(session({ kind: 'outdoor' }), [climb({})], ctx);
    expect(l.fingerLoad).toBe(12);
    // a pocket boulder 4 sub-grades below max -> moderate 0.55, grips half restricted
    const l2 = computeSessionLoads(session({ kind: 'outdoor' }), [climb({ grade: '5+', grips: ['pocket_2f_middle', 'half_crimp'] })], ctx);
    // 120 s x 0.55 x avg(1.3,1.0)=1.15 / 10 = 7.59 ; restricted half
    expect(l2.fingerLoad).toBe(7.6);
    expect(l2.restrictedGripLoad).toBe(3.8);
  });

  it('falls back to a kind-based fraction when nothing is logged', () => {
    // free session 120 min x 0.15 on holds x 60 s x high(0.8) / 10 = 86.4
    const l = computeSessionLoads(session({ kind: 'free', durationMin: 120, sessionRPE: 7 }), [], ctx);
    expect(l.fingerLoad).toBe(86.4);
    const other = computeSessionLoads(session({ kind: 'other_sport', durationMin: 60 }), [], ctx);
    expect(other.fingerLoad).toBe(0);
  });

  it('explicit climbingFingerMin overrides estimates', () => {
    const l = computeSessionLoads(session({ kind: 'projecting', climbingFingerMin: 10, climbingFingerIntensity: 'max' }), [climb({})], ctx);
    expect(l.fingerLoad).toBe(60);
  });
});

describe('grades', () => {
  it('computes sub-grade deltas', () => {
    expect(gradeDelta('7c', '7b', 'route')).toBe(2);
    expect(gradeDelta('7A', '6B', 'boulder')).toBe(4);
    expect(gradeDelta('foo', '6B', 'boulder')).toBeNull();
    expect(shiftGrade('7b', 2, 'route')).toBe('7c');
  });
});

/* ---------------- ACWR & cold start ---------------- */

const seed: ColdStartSeed = {
  sessionsPerWeek: 3, avgDurationMin: 90, avgSessionRPE: 7,
  fingerSessionsPerWeek: 3, fingerMinutesPerSession: 12, fingerIntensity: 'high', seededAt: '2026-11-01',
};
// seed: global 1890/week = 270/day ; finger 3 x 12 x 60 x 0.8 / 10 = 172.8/week

function regularWeeks(start: string, weeks: number, global = 630, finger = 57.6): DatedLoad[] {
  const out: DatedLoad[] = [];
  for (let w = 0; w < weeks; w++) for (const d of [1, 3, 5]) out.push({ date: addDays(start, w * 7 + d), globalLoad: global, fingerLoad: finger, restrictedGripLoad: 0 });
  return out;
}

describe('ACWR with cold start', () => {
  it('returns none without any data', () => {
    const r = computeACWR([], { metric: 'global', asOf: '2026-11-21', coldStart: null });
    expect(r.zone).toBe('none');
    expect(r.ratio).toBeNull();
  });

  it('is "calibrating" for the first 28 days, then reports a zone', () => {
    const loads = regularWeeks('2026-11-02', 8);
    const early = computeACWR(loads, { metric: 'global', asOf: '2026-11-20', coldStart: seed });
    expect(early.calibrating).toBe(true);
    expect(early.zone).toBe('calibrating');
    const later = computeACWR(loads, { metric: 'global', asOf: '2026-12-27', coldStart: seed });
    expect(later.calibrating).toBe(false);
    expect(later.zone).toBe('green');
    expect(later.ratio! > 0.8 && later.ratio! < 1.3).toBe(true);
  });

  it('seeding prevents absurd ratios on day one', () => {
    const loads = [{ date: '2026-11-01', globalLoad: 630, fingerLoad: 50, restrictedGripLoad: 0 }];
    const seeded = computeACWR(loads, { metric: 'global', asOf: '2026-11-01', coldStart: seed });
    const unseeded = computeACWR(loads, { metric: 'global', asOf: '2026-11-01', coldStart: null });
    expect(seeded.ratio! < 2).toBe(true);
    close(unseeded.ratio!, 29 / 8, 0.01); // (630/4) / (630*2/29)
  });

  it('a doubled week turns finger ACWR orange/red', () => {
    const base = regularWeeks('2026-10-05', 6);
    const spike = regularWeeks('2026-11-16', 1, 1200, 140);
    const r = computeACWR([...base, ...spike], { metric: 'finger', asOf: '2026-11-22', coldStart: { ...seed, seededAt: '2026-10-05' } });
    expect(['orange', 'red'].includes(r.zone)).toBe(true);
  });
});

describe('week-on-week and caps', () => {
  it('flags a >15 % jump; uses the cold-start week when no previous logs', () => {
    const loads: DatedLoad[] = [
      { date: '2026-11-03', globalLoad: 600, fingerLoad: 60, restrictedGripLoad: 0 },
      { date: '2026-11-10', globalLoad: 750, fingerLoad: 60, restrictedGripLoad: 0 },
    ];
    const w = weekOnWeek(loads, '2026-11-10', null);
    expect(w.globalPct).toBe(25);
    expect(w.globalFlag).toBe(true);
    expect(w.fingerFlag).toBe(false);
    const first = weekOnWeek([{ date: '2026-11-03', globalLoad: 1900, fingerLoad: 220, restrictedGripLoad: 0 }], '2026-11-03', seed);
    expect(first.previous.global).toBe(1890);
    expect(first.fingerFlag).toBe(true); // 220 vs 172.8 = +27 %
  });

  it('caps next-week finger load at +10 % of the habitual level', () => {
    const loads = regularWeeks('2026-10-05', 6); // 172.8 FLU/week
    const caps = fingerCapsForWeek(loads, '2026-11-16', { ...seed, seededAt: '2026-10-05' });
    expect(caps.weeklyFingerCap > 172.8 && caps.weeklyFingerCap <= 190.1).toBe(true);
    expect(caps.weeklyRestrictedCap >= caps.weeklyFingerCap * 0.05 - 0.05).toBe(true); // 5 % floor (rounded to 0.1)
    expect(caps.weeklyRestrictedCap <= caps.weeklyFingerCap * 0.25).toBe(true);
  });

  it('after a deload week the cap returns to the chronic level, not the deload level', () => {
    const loads = [...regularWeeks('2026-10-05', 5), ...regularWeeks('2026-11-09', 1, 300, 20)];
    const caps = fingerCapsForWeek(loads, '2026-11-16', { ...seed, seededAt: '2026-10-05' });
    expect(caps.basis).toBe('chronic');
    expect(caps.weeklyFingerCap > 100).toBe(true);
  });

  it('cold-start cap uses the seeded week while calibrating', () => {
    const caps = fingerCapsForWeek([], '2026-11-09', seed);
    expect(caps.basis).toBe('cold_start');
    expect(caps.weeklyFingerCap).toBe(190.1);
  });
});

describe('projection', () => {
  it('warns when planned sessions would push ACWR above green', () => {
    const loads = regularWeeks('2026-09-07', 10);
    const planned: DatedLoad[] = [0, 1, 2, 3, 4, 5].map((d) => ({ date: addDays('2026-11-16', d), globalLoad: 900, fingerLoad: 90, restrictedGripLoad: 0 }));
    const p = projectACWR(loads, planned, '2026-11-15', '2026-11-21', { ...seed, seededAt: '2026-09-07' });
    expect(p.warning).toBe(true);
    expect(p.peakFinger!.ratio > 1.3).toBe(true);
    const calm = projectACWR(loads, [{ date: '2026-11-17', globalLoad: 630, fingerLoad: 57.6, restrictedGripLoad: 0 }], '2026-11-15', '2026-11-21', { ...seed, seededAt: '2026-09-07' });
    expect(calm.warning).toBe(false);
  });

  it('toDatedLoads ignores tombstones', () => {
    expect(toDatedLoads([session({ deleted: true }), session({ globalLoad: 5 })])).toHaveLength(1);
  });
});
