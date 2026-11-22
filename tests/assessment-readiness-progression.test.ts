import { describe, expect, it } from 'vitest';
import { estimate1RMAdded, normsFor, rankWeaknesses } from '../src/engine/assessment';
import { computeReadiness, readinessSeries, sleepBaseline, trailingRun } from '../src/engine/readiness';
import { suggestProgression } from '../src/engine/progression';
import { buildLibrary } from '../src/engine/library';
import type { DailyCheckin, SetLog, SleepRecord } from '../src/data/schema';
import { BENCHMARKS, bench, profile } from './fixtures';

const lib = buildLibrary();

describe('assessment', () => {
  it('Epley 1RM estimate', () => {
    expect(estimate1RMAdded(25, 3, 74)).toBe(34.9);
    expect(estimate1RMAdded(30, 1, 74)).toBe(30);
  });

  it('interpolates norms between table grades', () => {
    expect(normsFor('7c').maxHangTotalPctBW).toBe(145);
    expect(normsFor('9a').maxHangTotalPctBW).toBe(157); // clamped
  });

  it('before any test: technique transfer (board/outdoor gap) + suspected finger strength & power on top', () => {
    const r = rankWeaknesses(profile(), [], undefined, [], '2026-11-23');
    expect(r.top[0]).toBe('technique_transfer');
    expect(r.top).toContain('power');
    expect(r.top).toContain('finger_strength');
    expect(r.top).toContain('technique_transfer');
    expect(r.ranked.find((d) => d.domain === 'finger_strength')!.confidence).toBe('low');
    const tt = r.ranked.find((d) => d.domain === 'technique_transfer')!;
    expect(tt.notes.join(' ')).toContain('to confirm');
    expect(r.caveat.length > 0).toBe(true);
  });

  it('with the fixture tests, measured gaps drive the ranking (repeaters weak -> power endurance)', () => {
    const r = rankWeaknesses(profile(), BENCHMARKS, undefined, [], '2026-11-23');
    expect(r.top).toContain('power_endurance');
    expect(r.ranked.find((d) => d.domain === 'finger_strength')!.components.tests! < 70).toBe(true);
  });

  it('a strong max hang moves finger strength out of the weakest spot', () => {
    const strong = [bench('max_hang_20mm_10s_hc', 45), ...BENCHMARKS.filter((b) => b.type !== 'max_hang_20mm_10s_hc')];
    const r = rankWeaknesses(profile(), strong, undefined, [], '2026-11-23');
    expect(r.ranked[0].domain === 'finger_strength').toBe(false);
  });

  it('questionnaire answers feed the ranking (reading/resting are strengths by default)', () => {
    const q = { id: 'q', createdAt: '', updatedAt: '', date: '2026-11-23', answers: { power_dynamic: 1 as const, power_contact_strength: 1 as const, confidence_limit_moves: 1 as const } };
    const r = rankWeaknesses(profile(), BENCHMARKS, q, [], '2026-11-23');
    expect(r.ranked.find((d) => d.domain === 'power')!.components.questionnaire).toBe(0);
  });
});

describe('readiness', () => {
  const ci = (p: Partial<DailyCheckin> = {}): DailyCheckin => ({
    id: 'c', createdAt: '', updatedAt: '', date: '2026-11-23', sleepQuality: 4, fatigue: 4, soreness: 4, stress: 4, motivation: 4, fingerStatus: 4, ...p,
  });
  const sl = (date: string, h: number, source: SleepRecord['source'] = 'manual'): SleepRecord => ({ id: date + source, createdAt: '', updatedAt: '', date, durationH: h, source });

  it('good day -> proceed; bad day -> rest; low finger status flagged separately', () => {
    expect(computeReadiness(ci(), sl('2026-11-23', 7.5), 7.5, 'normal').advice).toBe('proceed');
    const bad = computeReadiness(ci({ fatigue: 1, soreness: 2, sleepQuality: 1, motivation: 2, stress: 2 }), sl('2026-11-23', 5), 7.5, 'normal');
    expect(bad.advice).toBe('rest');
    expect(bad.sleepBelowBaseline).toBe(true);
    expect(computeReadiness(ci({ fingerStatus: 2 }), undefined, 7.5, 'normal').fingerLow).toBe(true);
  });

  it('newborn mode tolerates fragmented sleep', () => {
    const c = ci({ sleepQuality: 2, fatigue: 3 });
    const s = sl('2026-11-23', 5.5);
    const normal = computeReadiness(c, s, 7.5, 'normal');
    const newborn = computeReadiness(c, s, 7.5, 'newborn');
    expect(newborn.score! > normal.score!).toBe(true);
    expect(normal.advice === 'proceed').toBe(false);
    expect(newborn.advice).toBe('proceed');
  });

  it('baseline = median of last 28 days (Garmin preferred), default if too few nights', () => {
    const recs = Array.from({ length: 10 }, (_, i) => sl(`2026-11-${String(10 + i).padStart(2, '0')}`, 7 + (i % 2) * 0.5));
    recs.push(sl('2026-11-12', 9, 'garmin'));
    expect(sleepBaseline(recs, { sleepBaselineH: null }, '2026-11-23')).toBe(7.5);
    expect(sleepBaseline(recs.slice(0, 3), { sleepBaselineH: null }, '2026-11-23')).toBe(7.5);
    expect(sleepBaseline(recs, { sleepBaselineH: 8 }, '2026-11-23')).toBe(8);
  });

  it('series + trailing run', () => {
    const checkins = ['2026-11-21', '2026-11-22', '2026-11-23'].map((d) => ci({ date: d, fatigue: 1, soreness: 1, sleepQuality: 1 }));
    const s = readinessSeries(checkins, [], { sleepBaselineH: null, mode: 'normal' }, '2026-11-23', 5);
    expect(s).toHaveLength(5);
    expect(trailingRun(s, (x) => x.advice === 'rest' || x.advice === 'lighter')).toBe(3);
  });
});

describe('progression', () => {
  const set = (p: Partial<SetLog>): SetLog => ({ id: 's', exerciseId: 'max_hang_20_hc', setIndex: 0, completed: true, reps: 1, workS: 10, load: { mode: 'added_kg', value: 10 }, rpe: 7, at: '2026-11-24T18:00:00Z', ...p });
  const mh = lib.get('max_hang_20_hc')!;
  const base = { exercise: mh, previousFailed: false, bodyMassKg: 74, current: { mode: 'added_kg' as const, value: 10 } };

  it('+2.5 % BW (1.85 -> 2 kg) when all sets done at RPE ≤ 8', () => {
    const s = suggestProgression({ ...base, lastSets: [set({}), set({ rpe: 8 })] });
    expect(s.action).toBe('increase');
    expect(s.newValue).toBe(12);
  });
  it('holds at RPE 9, holds after one failure, reduces after two', () => {
    expect(suggestProgression({ ...base, lastSets: [set({ rpe: 9 })] }).action).toBe('hold');
    const f1 = suggestProgression({ ...base, lastSets: [set({ completed: false })] });
    expect([f1.action, f1.failed]).toEqual(['hold', true]);
    const f2 = suggestProgression({ ...base, previousFailed: true, lastSets: [set({ completed: false })] });
    expect(f2.action).toBe('decrease');
    expect(f2.newValue).toBe(6); // 5 % of total 84 kg = 4.2 -> 4 kg (0.5 kg rounding)
  });
  it('blocks finger progression on low finger status or recent pain, and caps weekly increase', () => {
    expect(suggestProgression({ ...base, lastSets: [set({})], fingerStatusLow: true }).action).toBe('hold');
    expect(suggestProgression({ ...base, lastSets: [set({})], recentFingerPainMax: 3 }).action).toBe('hold');
    const capped = suggestProgression({ ...base, lastSets: [set({})], increaseThisWeekKg: 1 });
    expect(capped.newValue).toBe(11); // cap 2 kg/week, 1 already used
  });
  it('assisted work progresses by removing less assistance', () => {
    const rep = lib.get('repeaters_7_3')!;
    const s = suggestProgression({ ...base, exercise: rep, current: { mode: 'removed_kg', value: 15 }, lastSets: [set({ exerciseId: 'repeaters_7_3', load: { mode: 'removed_kg', value: 15 } })] });
    expect(s.newValue).toBe(13);
  });
  it('non-finger pull-ups step by 2.5 kg', () => {
    const pu = lib.get('weighted_pullup')!;
    const s = suggestProgression({ ...base, exercise: pu, current: { mode: 'added_kg', value: 20 }, lastSets: [set({ exerciseId: 'weighted_pullup' })] });
    expect(s.newValue).toBe(22.5);
  });
});
