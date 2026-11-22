/**
 * Exercise library = JSON config (src/config/exercises.json) + user-built custom exercises.
 * Also builds the LoadContext used by the load engine from the latest profile/benchmarks.
 */
import { exerciseLibrary } from '../config';
import type { BenchmarkResult, BenchmarkType, CustomExercise, ExerciseDef, ProfileEntry } from '../data/schema';
import type { LoadContext } from './load';

export type Library = Map<string, ExerciseDef>;

export function buildLibrary(custom: CustomExercise[] = [], base: ExerciseDef[] = exerciseLibrary): Library {
  const lib: Library = new Map();
  for (const e of base) lib.set(e.id, e);
  for (const c of custom) {
    if (c.deleted) continue;
    const { createdAt: _c, updatedAt: _u, deleted: _d, ...def } = c;
    void _c; void _u; void _d;
    lib.set(c.id, { ...(def as Omit<ExerciseDef, 'id'>), id: c.id, custom: true });
  }
  return lib;
}

/** Latest result per benchmark type (and per hand for hand-specific tests). Key: type or `type:hand`. */
export function latestBenchmarks(all: BenchmarkResult[]): Map<string, BenchmarkResult> {
  const out = new Map<string, BenchmarkResult>();
  const sorted = all.filter((b) => !b.deleted).sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
  for (const b of sorted) {
    out.set(b.type, b);
    if (b.hand && b.hand !== 'both') out.set(`${b.type}:${b.hand}`, b);
  }
  return out;
}

export function benchmarkValue(latest: Map<string, BenchmarkResult>, type: BenchmarkType, hand?: 'left' | 'right'): number | null {
  const b = latest.get(hand ? `${type}:${hand}` : type);
  return b ? b.value : null;
}

export function buildLoadContext(profile: ProfileEntry, benchmarks: BenchmarkResult[], lib: Library): LoadContext {
  const latest = latestBenchmarks(benchmarks);
  return {
    bodyMassKg: profile.bodyMassKg,
    maxHangAddedKg: benchmarkValue(latest, 'max_hang_20mm_10s_hc'),
    exercise: (id) => {
      const e = lib.get(id);
      return e ? { category: e.category, fingerIntensity: e.fingerIntensity, defaultGrip: e.defaultGrip, edgeMm: e.edgeMm } : undefined;
    },
    grades: {
      sportRedpoint: profile.gradeSportRedpoint,
      boulderOutdoor: profile.gradeBoulderOutdoor,
      boulderBoard: profile.gradeBoulderBoard,
    },
  };
}
