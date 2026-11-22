import { describe, expect, it } from 'vitest';
import { buildColdStartSeed, calibrationStatus, SUGGESTED_COLD_START, validateColdStart } from '../src/engine/coldStart';

describe('cold start', () => {
  it('validates inputs', () => {
    expect(validateColdStart(SUGGESTED_COLD_START)).toHaveLength(0);
    const bad = validateColdStart({ ...SUGGESTED_COLD_START, avgSessionRPE: 14, fingerMinutesPerSession: -1 });
    expect(bad.map((i) => i.field)).toEqual(['avgSessionRPE', 'fingerMinutesPerSession']);
  });

  it('clamps values when building the seed', () => {
    const s = buildColdStartSeed({ ...SUGGESTED_COLD_START, avgSessionRPE: 14 }, '2026-11-21');
    expect(s.avgSessionRPE).toBe(10);
    expect(s.seededAt).toBe('2026-11-21');
  });

  it('reports calibration progress from the seed date', () => {
    const seed = buildColdStartSeed(SUGGESTED_COLD_START, '2026-11-21');
    const day1 = calibrationStatus([], seed, '2026-11-21');
    expect(day1.calibrating).toBe(true);
    expect(day1.daysRemaining).toBe(27);
    expect(day1.seededWeekly.global).toBe(1890);
    expect(day1.seededWeekly.finger).toBe(172.8);
    const done = calibrationStatus([], seed, '2026-12-18');
    expect(done.calibrating).toBe(false);
    expect(done.progressPct).toBe(100);
  });

  it('without seed or logs there is nothing to calibrate from', () => {
    const s = calibrationStatus([], null, '2026-11-21');
    expect(s.daysOfData).toBe(0);
    expect(s.calibrating).toBe(true);
  });
});
