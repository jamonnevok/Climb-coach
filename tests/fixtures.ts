/** Shared fixtures for engine tests (owner's profile, 2026-11). */
import { defaultSettings, initialProfile } from '../src/data/defaults';
import type { BenchmarkResult, ProfileEntry, Settings } from '../src/data/schema';
import { buildLibrary, buildLoadContext } from '../src/engine/library';
import { rankWeaknesses } from '../src/engine/assessment';
import type { GeneratorInput } from '../src/engine/planGenerator';
import { buildColdStartSeed, SUGGESTED_COLD_START } from '../src/engine/coldStart';

export const TODAY = '2026-11-23'; // Monday

export function profile(): ProfileEntry {
  return initialProfile('2026-11-21', new Date('2026-11-21T10:00:00Z'));
}

export function settings(patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(new Date('2026-11-21T10:00:00Z')), coldStart: buildColdStartSeed(SUGGESTED_COLD_START, '2026-11-21'), onboardingDone: true, ...patch };
}

let n = 0;
export function bench(type: BenchmarkResult['type'], value: number, extra: Partial<BenchmarkResult> = {}): BenchmarkResult {
  n++;
  return {
    id: `b${n}`, createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z', date: '2026-11-20', type, value,
    unit: type === 'repeaters_7_3_20mm' ? 'kg_removed' : 'kg_added', bodyMassKg: 74, source: 'manual', ...extra,
  };
}

export const BENCHMARKS: BenchmarkResult[] = [
  bench('max_hang_20mm_10s_hc', 22), // total 96 kg = 130 % BW
  bench('weighted_pullup', 25, { reps: 3 }),
  bench('repeaters_7_3_20mm', 15, { repsToFailure: 24 }),
  bench('front_lever', 2, { unit: 'level' }),
  bench('max_lockoff', 18, { unit: 's' }),
];

export function genInput(over: Partial<GeneratorInput> = {}, benchmarks: BenchmarkResult[] = BENCHMARKS, st: Settings = settings()): GeneratorInput {
  const p = profile();
  const lib = buildLibrary();
  return {
    today: TODAY,
    profile: p,
    settings: st,
    benchmarks,
    ranking: rankWeaknesses(p, benchmarks, undefined, [], TODAY),
    loads: [],
    library: lib,
    ctx: buildLoadContext(p, benchmarks, lib),
    hasTindeq: true,
    ...over,
  };
}
