/**
 * Force-curve analysis for Tindeq data. Pure functions.
 *  - peak / mean / time under load
 *  - live target band status (hangs, no-hang lifts, isometrics)
 *  - repeater rep segmentation + force-drop detection (auto-end a set)
 *  - critical force from an all-out 7:3 test (implementation: mean force of the last N
 *    contractions, a common end-test plateau estimate; Giles et al. 2019 validated a
 *    single-session CF protocol — label: coaching_practice implementation)
 *  - asymmetry & baseline "watch" (EXPERIMENTAL — never a diagnosis)
 *  - downsampling for storage (keeps the exact peak)
 */
import { thresholds as defaultThresholds, type Thresholds } from '../config';
import { addDays, type ISODate } from '../lib/dates';
import type { BenchmarkResult } from '../data/schema';

export interface Pt {
  /** ms since start */
  t: number;
  /** kg */
  f: number;
}

const cfg = (c?: Thresholds) => (c ?? defaultThresholds).tindeq;

export function peak(points: Pt[]): number {
  return points.reduce((m, p) => (p.f > m ? p.f : m), 0);
}

/** Time-weighted mean force over [t0, t1] (whole curve by default). */
export function meanForce(points: Pt[], t0 = -Infinity, t1 = Infinity): number {
  const xs = points.filter((p) => p.t >= t0 && p.t <= t1);
  if (xs.length < 2) return xs[0]?.f ?? 0;
  let area = 0;
  for (let i = 1; i < xs.length; i++) area += ((xs[i].f + xs[i - 1].f) / 2) * (xs[i].t - xs[i - 1].t);
  const dur = xs[xs.length - 1].t - xs[0].t;
  return dur > 0 ? area / dur : xs[0].f;
}

/** Seconds above the load-onset threshold. */
export function timeUnderLoadS(points: Pt[], c?: Thresholds): number {
  const onset = cfg(c).loadOnsetKg;
  let ms = 0;
  for (let i = 1; i < points.length; i++) if (points[i - 1].f >= onset) ms += points[i].t - points[i - 1].t;
  return ms / 1000;
}

export type BandStatus = 'idle' | 'below' | 'in' | 'above';

export function bandStatus(currentKg: number, targetKg: number | null, c?: Thresholds): BandStatus {
  const k = cfg(c);
  if (currentKg < k.loadOnsetKg) return 'idle';
  if (!targetKg) return 'in';
  const tol = (k.targetBandPct / 100) * targetKg;
  if (currentKg < targetKg - tol) return 'below';
  if (currentKg > targetKg + tol) return 'above';
  return 'in';
}

/* ------------------------------------------------------------------ */
/* Repeaters                                                           */
/* ------------------------------------------------------------------ */

export interface RepStat {
  index: number;
  startMs: number;
  endMs: number;
  meanKg: number;
  peakKg: number;
  /** Fraction of the work window spent above the onset threshold. */
  loadedFraction: number;
}

/**
 * Stats for one repetition given its scheduled work window (from the timer), ignoring
 * the first 0.5 s (loading ramp).
 */
export function repStat(points: Pt[], index: number, startMs: number, endMs: number, c?: Thresholds): RepStat {
  const onset = cfg(c).loadOnsetKg;
  const xs = points.filter((p) => p.t >= startMs && p.t <= endMs);
  const steady = xs.filter((p) => p.t >= startMs + 500);
  let loadedMs = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i - 1].f >= onset) loadedMs += xs[i].t - xs[i - 1].t;
  return {
    index,
    startMs,
    endMs,
    meanKg: Math.round(meanForce(steady.length >= 2 ? steady : xs) * 10) / 10,
    peakKg: Math.round(peak(xs) * 10) / 10,
    loadedFraction: endMs > startMs ? loadedMs / (endMs - startMs) : 0,
  };
}

export interface DropDecision {
  stop: boolean;
  reason: string | null;
  referenceKg: number | null;
  /** Rep indices considered failed. */
  failedReps: number[];
}

/**
 * Force-drop detection for repeaters. Reference = target force, or the mean of the first
 * `repeaterReferenceReps` reps. A rep fails if its mean is > dropPct below reference or if
 * the hand came off (loaded fraction too low). `repeaterDropConsecutive` failed reps in a row
 * -> stop the set.
 */
export function detectForceDrop(reps: RepStat[], targetKg: number | null, c?: Thresholds): DropDecision {
  const k = cfg(c);
  const refReps = reps.slice(0, k.repeaterReferenceReps);
  const ref = targetKg ?? (refReps.length === k.repeaterReferenceReps ? refReps.reduce((a, r) => a + r.meanKg, 0) / refReps.length : null);
  if (ref === null) return { stop: false, reason: null, referenceKg: null, failedReps: [] };
  const limit = ref * (1 - k.repeaterDropPct / 100);
  const failed = reps.filter((r) => r.meanKg < limit || r.loadedFraction < k.repeaterMinRepFractionAboveOnset).map((r) => r.index);
  let run = 0;
  for (let i = reps.length - 1; i >= 0 && failed.includes(reps[i].index); i--) run++;
  const stop = run >= k.repeaterDropConsecutive;
  return {
    stop,
    reason: stop ? `Force dropped > ${k.repeaterDropPct} % below ${ref.toFixed(1)} kg for ${run} reps in a row.` : null,
    referenceKg: Math.round(ref * 10) / 10,
    failedReps: failed,
  };
}

/* ------------------------------------------------------------------ */
/* Critical force                                                      */
/* ------------------------------------------------------------------ */

export interface CriticalForceResult {
  cfKg: number;
  peakKg: number;
  cfPctOfPeak: number;
  repsUsed: number;
  /** W' proxy: impulse above CF over the test (kg·s). Indicative. */
  wPrimeKgS: number;
}

export function criticalForce(reps: RepStat[], c?: Thresholds): CriticalForceResult | null {
  const n = cfg(c).criticalForceLastReps;
  if (reps.length < n + 4) return null;
  const last = reps.slice(-n);
  const cf = last.reduce((a, r) => a + r.meanKg, 0) / n;
  const pk = Math.max(...reps.map((r) => r.peakKg));
  const wPrime = reps.reduce((a, r) => a + Math.max(0, r.meanKg - cf) * ((r.endMs - r.startMs) / 1000), 0);
  return {
    cfKg: Math.round(cf * 10) / 10,
    peakKg: Math.round(pk * 10) / 10,
    cfPctOfPeak: pk > 0 ? Math.round((cf / pk) * 1000) / 10 : 0,
    repsUsed: n,
    wPrimeKgS: Math.round(wPrime),
  };
}

/* ------------------------------------------------------------------ */
/* Asymmetry & baseline watch (EXPERIMENTAL)                           */
/* ------------------------------------------------------------------ */

export interface AsymmetryWatch {
  leftKg: number | null;
  rightKg: number | null;
  asymmetryPct: number | null;
  asymmetryWatch: boolean;
  baseline: { left: number | null; right: number | null };
  dropPct: { left: number | null; right: number | null };
  baselineWatch: { left: boolean; right: boolean };
  messages: string[];
  experimental: true;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Compare the latest left/right peak-force tests with each other and with each hand's own
 * rolling baseline (median of up to `baselineMaxTests` previous tests in `baselineWindowDays`).
 */
export function asymmetryWatch(benchmarks: BenchmarkResult[], asOf: ISODate, c?: Thresholds): AsymmetryWatch {
  const k = cfg(c);
  const tests = benchmarks
    .filter((b) => !b.deleted && b.type === 'tindeq_peak_force' && (b.hand === 'left' || b.hand === 'right') && b.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
  const from = addDays(asOf, -k.baselineWindowDays);
  const side = (hand: 'left' | 'right') => {
    const xs = tests.filter((t) => t.hand === hand);
    const latest = xs[xs.length - 1] ?? null;
    const prev = xs.slice(0, -1).filter((t) => t.date >= from).slice(-k.baselineMaxTests);
    const base = prev.length >= k.baselineMinTests ? median(prev.map((t) => t.value)) : null;
    const drop = latest && base ? Math.round(((base - latest.value) / base) * 1000) / 10 : null;
    return { latest: latest?.value ?? null, base, drop };
  };
  const L = side('left');
  const R = side('right');
  const messages: string[] = [];
  let asym: number | null = null;
  if (L.latest !== null && R.latest !== null) {
    asym = Math.round((Math.abs(L.latest - R.latest) / Math.max(L.latest, R.latest)) * 1000) / 10;
  }
  const asymmetryWatch = asym !== null && asym > k.asymmetryWatchPct;
  if (asymmetryWatch) messages.push(`Left/right difference ${asym} % (> ${k.asymmetryWatchPct} %). Watch signal only — compare with how the fingers feel.`);
  const bw = { left: (L.drop ?? 0) > k.baselineDropWatchPct, right: (R.drop ?? 0) > k.baselineDropWatchPct };
  if (bw.left) messages.push(`Left hand ${L.drop} % below its recent baseline. Watch signal only.`);
  if (bw.right) messages.push(`Right hand ${R.drop} % below its recent baseline. Watch signal only.`);
  return {
    leftKg: L.latest,
    rightKg: R.latest,
    asymmetryPct: asym,
    asymmetryWatch,
    baseline: { left: L.base, right: R.base },
    dropPct: { left: L.drop, right: R.drop },
    baselineWatch: bw,
    messages,
    experimental: true,
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Bucket downsampling keeping min/max per bucket; the global peak is always preserved. */
export function downsample(points: Pt[], maxPoints?: number, c?: Thresholds): Pt[] {
  const max = maxPoints ?? cfg(c).curveMaxPoints;
  if (points.length <= max) return points.slice();
  const buckets = Math.floor(max / 2);
  const size = points.length / buckets;
  const out: Pt[] = [];
  for (let b = 0; b < buckets; b++) {
    const xs = points.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!xs.length) continue;
    let lo = xs[0];
    let hi = xs[0];
    for (const p of xs) {
      if (p.f < lo.f) lo = p;
      if (p.f > hi.f) hi = p;
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo.t < hi.t ? [lo, hi] : [hi, lo]));
  }
  return out;
}

export function round1(points: Pt[]): { t: number[]; f: number[] } {
  return { t: points.map((p) => Math.round(p.t)), f: points.map((p) => Math.round(p.f * 10) / 10) };
}
