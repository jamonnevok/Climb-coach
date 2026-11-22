/**
 * LOAD ENGINE
 *
 * Two independent load channels, each with its own acute:chronic ratio:
 *  - GLOBAL load (Foster session-RPE): sRPE (0-10) x duration (min) = arbitrary units (AU).
 *  - FINGER load (FLU, finger-load units, coaching-practice index):
 *        seconds under finger load x relativeIntensity^exp x gripFactor x edgeFactor / secondsPerUnit
 *    from (a) logged/planned finger sets and (b) a climbing estimate.
 *    "Restricted" grips (full crimp, 2-finger pockets, mono) are also summed separately.
 *
 * ACWR uses exponentially weighted moving averages (Williams et al. 2017):
 *        EWMA_today = lambda * load_today + (1 - lambda) * EWMA_yesterday,   lambda = 2 / (N + 1)
 * with N = 7 (acute) and N = 28 (chronic), on a DAILY series including rest days (load 0).
 *
 * All factors live in src/config/thresholds.json. Pure functions only — no I/O.
 */
import { thresholds as defaultThresholds, type Thresholds } from '../config';
import { addDays, dateRange, diffDays, startOfWeek, type ISODate } from '../lib/dates';
import { gradeDelta } from '../lib/grades';
import {
  RESTRICTED_GRIPS,
  type ClimbLog,
  type ColdStartSeed,
  type ExerciseCategory,
  type FingerIntensity,
  type Grip,
  type LoadMode,
  type PlannedItem,
  type PlannedSession,
  type SessionKind,
  type SessionLog,
  type SetLog,
} from '../data/schema';

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

export interface ExerciseFingerInfo {
  category: ExerciseCategory;
  fingerIntensity: FingerIntensity;
  defaultGrip?: Grip;
  edgeMm?: number;
}

export interface LoadContext {
  bodyMassKg: number;
  /** Latest max hang 20 mm / 10 s / half crimp, kg ADDED (negative = assisted). null = unknown. */
  maxHangAddedKg: number | null;
  exercise: (id: string) => ExerciseFingerInfo | undefined;
  grades: { sportRedpoint: string; boulderOutdoor: string; boulderBoard: string };
  config?: Thresholds;
}

export interface FingerLoadResult {
  flu: number;
  restricted: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const isRestricted = (g: Grip | undefined) => !!g && RESTRICTED_GRIPS.includes(g);
const cfgOf = (ctx: { config?: Thresholds }) => ctx.config ?? defaultThresholds;

/* ------------------------------------------------------------------ */
/* Global load (Foster)                                                */
/* ------------------------------------------------------------------ */

export function fosterLoad(sessionRPE: number, durationMin: number): number {
  return Math.round(clamp(sessionRPE, 0, 10) * Math.max(0, durationMin));
}

/* ------------------------------------------------------------------ */
/* Finger load                                                         */
/* ------------------------------------------------------------------ */

export function intensityFromRPE(rpe: number): FingerIntensity {
  if (rpe <= 3) return 'low';
  if (rpe <= 6) return 'moderate';
  if (rpe <= 8) return 'high';
  return 'max';
}

/** Total hanging load (kg) that corresponds to 100 % on the 20 mm reference edge, both hands. */
export function referenceMaxTotalKg(ctx: LoadContext): number {
  const c = cfgOf(ctx).fingerLoad;
  return ctx.maxHangAddedKg === null
    ? ctx.bodyMassKg * c.defaultMaxHangTotalBwRatio
    : ctx.bodyMassKg + ctx.maxHangAddedKg;
}

/** Total load (kg) borne by the fingers for a given load prescription. null = not load-based. */
export function totalLoadKg(mode: LoadMode, value: number | null, bodyMassKg: number): number | null {
  const v = value ?? 0;
  switch (mode) {
    case 'added_kg':
      return bodyMassKg + v;
    case 'removed_kg':
      return bodyMassKg - v;
    case 'percent_bw': // added load as % body mass (negative = assistance)
      return bodyMassKg * (1 + v / 100);
    case 'bodyweight':
      return bodyMassKg;
    case 'target_force_kg':
      return value === null ? null : v;
    default:
      return null;
  }
}

/** Relative intensity vs the reference max (one-hand work is compared with half the two-hand max). */
export function relativeIntensity(
  load: { mode: LoadMode; value: number | null },
  hand: SetLog['hand'],
  info: ExerciseFingerInfo,
  ctx: LoadContext,
): number {
  const c = cfgOf(ctx).fingerLoad;
  const total = totalLoadKg(load.mode, load.value, ctx.bodyMassKg);
  if (total === null) return c.intensityFactor[info.fingerIntensity];
  const oneHand = hand === 'left' || hand === 'right';
  const ref = referenceMaxTotalKg(ctx) / (oneHand ? 2 : 1);
  const [lo, hi] = c.intensityClamp;
  return clamp(total / Math.max(1, ref), lo, hi);
}

export function edgeFactor(edgeMm: number | undefined, ctx: { config?: Thresholds }): number {
  const c = cfgOf(ctx).fingerLoad;
  if (!edgeMm || edgeMm <= 0) return 1;
  const [lo, hi] = c.edgeFactorClamp;
  return clamp(Math.sqrt(c.edgeReferenceMm / edgeMm), lo, hi);
}

export function gripFactor(grip: Grip | undefined, ctx: { config?: Thresholds }): number {
  const f = cfgOf(ctx).fingerLoad.gripFactor as Record<string, number>;
  return f[grip ?? 'mixed'] ?? 1;
}

function fluFromSeconds(seconds: number, intensity: number, grip: Grip | undefined, edgeMm: number | undefined, ctx: LoadContext) {
  const c = cfgOf(ctx).fingerLoad;
  if (seconds <= 0 || intensity <= 0) return 0;
  return (seconds * Math.pow(intensity, c.intensityExponent) * gripFactor(grip, ctx) * edgeFactor(edgeMm, ctx)) / c.secondsPerUnit;
}

/** Finger load of one logged set (hang, repeater cycle block, isometric, etc.). */
export function setFingerLoad(set: SetLog, ctx: LoadContext): FingerLoadResult {
  const info = ctx.exercise(set.exerciseId);
  if (!info || info.fingerIntensity === 'none') return { flu: 0, restricted: 0 };
  const seconds = Math.max(0, set.reps) * Math.max(0, set.workS);
  const grip = set.grip ?? info.defaultGrip;
  const rel = relativeIntensity(set.load, set.hand, info, ctx);
  const flu = fluFromSeconds(seconds, rel, grip, set.edgeMm ?? info.edgeMm, ctx);
  return { flu, restricted: isRestricted(grip) ? flu : 0 };
}

/** Climbing intensity from a climb's grade relative to the climber's current max for that setting. */
export function climbIntensity(climb: ClimbLog, ctx: LoadContext): FingerIntensity {
  const ref =
    climb.discipline === 'route'
      ? ctx.grades.sportRedpoint
      : climb.setting === 'board'
        ? ctx.grades.boulderBoard
        : ctx.grades.boulderOutdoor;
  const delta = gradeDelta(climb.grade, ref, climb.discipline);
  if (delta === null) return 'moderate';
  for (const step of cfgOf(ctx).fingerLoad.climbing.gradeDeltaToIntensity) {
    if (delta >= step.minDelta) return step.intensity as FingerIntensity;
  }
  return 'low';
}

function climbGripFactorAndShare(grips: Grip[], ctx: LoadContext) {
  if (!grips.length) return { factor: gripFactor('mixed', ctx), restrictedShare: 0 };
  const factor = grips.reduce((s, g) => s + gripFactor(g, ctx), 0) / grips.length;
  const restrictedShare = grips.filter(isRestricted).length / grips.length;
  return { factor, restrictedShare };
}

/**
 * Finger load from climbing. Priority:
 *  1. explicit `climbingFingerMin` on the session (guided sessions / user override);
 *  2. derived from logged climbs (attempts x minutes-on-holds x grade-relative intensity x grips);
 *  3. fallback: fraction of duration by session kind (only if no finger sets were logged).
 */
export function climbingFingerLoad(session: SessionLog, climbs: ClimbLog[], hasFingerSets: boolean, ctx: LoadContext): FingerLoadResult {
  const c = cfgOf(ctx).fingerLoad;
  const own = climbs.filter((cl) => !cl.deleted);

  if (session.climbingFingerMin && session.climbingFingerMin > 0) {
    const intensity = c.intensityFactor[session.climbingFingerIntensity ?? intensityFromRPE(session.sessionRPE)];
    const allGrips = own.flatMap((cl) => cl.grips);
    const { factor, restrictedShare } = climbGripFactorAndShare(allGrips, ctx);
    const flu = (session.climbingFingerMin * 60 * intensity * factor) / c.secondsPerUnit;
    return { flu, restricted: flu * restrictedShare };
  }

  if (own.length) {
    let flu = 0;
    let restricted = 0;
    for (const cl of own) {
      const minutes = Math.max(1, cl.attempts) * (cl.discipline === 'boulder' ? c.climbing.boulderAttemptMin : c.climbing.routeBurnMin);
      const intensity = c.intensityFactor[climbIntensity(cl, ctx)];
      const { factor, restrictedShare } = climbGripFactorAndShare(cl.grips, ctx);
      const x = (minutes * 60 * intensity * factor) / c.secondsPerUnit;
      flu += x;
      restricted += x * restrictedShare;
    }
    return { flu, restricted };
  }

  if (hasFingerSets) return { flu: 0, restricted: 0 };
  const fractions = c.climbing.fallbackOnHoldsFractionByKind as Record<SessionKind, number>;
  const frac = fractions[session.kind] ?? 0;
  const flu = (session.durationMin * frac * 60 * c.intensityFactor[intensityFromRPE(session.sessionRPE)]) / c.secondsPerUnit;
  return { flu, restricted: 0 };
}

export interface SessionLoads {
  globalLoad: number;
  fingerLoad: number;
  restrictedGripLoad: number;
  breakdown: { sets: number; climbing: number };
}

/** Compute (and cache on the record at save time) all loads of a session. */
export function computeSessionLoads(session: SessionLog, climbs: ClimbLog[], ctx: LoadContext): SessionLoads {
  let setsFlu = 0;
  let restricted = 0;
  let hasFingerSets = false;
  for (const s of session.sets) {
    const r = setFingerLoad(s, ctx);
    if (r.flu > 0) hasFingerSets = true;
    setsFlu += r.flu;
    restricted += r.restricted;
  }
  const climbing = climbingFingerLoad(session, climbs, hasFingerSets, ctx);
  return {
    globalLoad: fosterLoad(session.sessionRPE, session.durationMin),
    fingerLoad: round1(setsFlu + climbing.flu),
    restrictedGripLoad: round1(restricted + climbing.restricted),
    breakdown: { sets: round1(setsFlu), climbing: round1(climbing.flu) },
  };
}

export function withComputedLoads(session: SessionLog, climbs: ClimbLog[], ctx: LoadContext): SessionLog {
  const l = computeSessionLoads(session, climbs, ctx);
  return { ...session, globalLoad: l.globalLoad, fingerLoad: l.fingerLoad, restrictedGripLoad: l.restrictedGripLoad };
}

/* ------------------------------------------------------------------ */
/* Planned-session estimates (used by the generator & projections)     */
/* ------------------------------------------------------------------ */

export interface PlannedEstimateConfig {
  /** Fraction of a climbing block's duration actually spent on holds. */
  climbBlockOnHoldsFraction: number;
}
const PLANNED_DEFAULTS: PlannedEstimateConfig = { climbBlockOnHoldsFraction: 0.15 };

export function plannedItemFingerLoad(item: PlannedItem, ctx: LoadContext, opts = PLANNED_DEFAULTS): FingerLoadResult {
  const info = ctx.exercise(item.exerciseId);
  if (!info || info.fingerIntensity === 'none') return { flu: 0, restricted: 0 };
  const t = item.timer;
  let seconds: number;
  if (t.kind === 'arc') seconds = t.totalS ?? 0; // continuous climbing
  else if (t.totalS && (t.kind === 'none' || t.kind === 'countdown' || t.kind === 'emom')) {
    // Climbing-type blocks (climbing, technique, power, endurance, tests on the wall, warm-up climbing):
    // only a fraction of the block is spent on holds. Pure finger work (hangboard) counts fully.
    const onWall = info.category !== 'finger' && info.category !== 'prehab';
    seconds = t.totalS * (onWall ? opts.climbBlockOnHoldsFraction : 1);
  } else seconds = t.sets * t.reps * t.workS;
  const grip = item.grip ?? info.defaultGrip;
  const intensity =
    item.load.mode === 'grade' || item.load.mode === 'none'
      ? cfgOf(ctx).fingerLoad.intensityFactor[info.fingerIntensity]
      : relativeIntensity(item.load, undefined, info, ctx);
  const flu = fluFromSeconds(seconds, intensity, grip, item.edgeMm ?? info.edgeMm, ctx);
  return { flu, restricted: isRestricted(grip) ? flu : 0 };
}

export function estimatePlannedSession(ps: Pick<PlannedSession, 'items' | 'estDurationMin' | 'estSessionRPE'>, ctx: LoadContext) {
  let flu = 0;
  let restricted = 0;
  for (const it of ps.items) {
    const r = plannedItemFingerLoad(it, ctx);
    flu += r.flu;
    restricted += r.restricted;
  }
  return { globalLoad: fosterLoad(ps.estSessionRPE, ps.estDurationMin), fingerLoad: round1(flu), restrictedGripLoad: round1(restricted) };
}

/* ------------------------------------------------------------------ */
/* Daily series, EWMA, ACWR                                            */
/* ------------------------------------------------------------------ */

export type LoadMetric = 'global' | 'finger' | 'restricted';

export interface DatedLoad {
  date: ISODate;
  globalLoad: number;
  fingerLoad: number;
  restrictedGripLoad: number;
}

const pick = (l: DatedLoad, m: LoadMetric) => (m === 'global' ? l.globalLoad : m === 'finger' ? l.fingerLoad : l.restrictedGripLoad);

export function toDatedLoads(sessions: SessionLog[]): DatedLoad[] {
  return sessions.filter((s) => !s.deleted).map((s) => ({
    date: s.date,
    globalLoad: s.globalLoad,
    fingerLoad: s.fingerLoad,
    restrictedGripLoad: s.restrictedGripLoad,
  }));
}

/** Daily totals over [from, to], zero-filled. */
export function dailySeries(loads: DatedLoad[], from: ISODate, to: ISODate, metric: LoadMetric): { date: ISODate; load: number }[] {
  const sums = new Map<ISODate, number>();
  for (const l of loads) if (l.date >= from && l.date <= to) sums.set(l.date, (sums.get(l.date) ?? 0) + pick(l, metric));
  return dateRange(from, to).map((date) => ({ date, load: sums.get(date) ?? 0 }));
}

export const ewmaLambda = (n: number) => 2 / (n + 1);

/** EWMA over a value array, starting from `seed` (the EWMA "yesterday" of the first value). */
export function ewma(values: number[], n: number, seed = 0): number[] {
  const lambda = ewmaLambda(n);
  const out: number[] = [];
  let prev = seed;
  for (const v of values) {
    prev = lambda * v + (1 - lambda) * prev;
    out.push(prev);
  }
  return out;
}

export type AcwrZone = 'none' | 'calibrating' | 'low' | 'green' | 'orange' | 'red';

export function zoneFor(ratio: number | null, ctx: { config?: Thresholds } = {}): Exclude<AcwrZone, 'calibrating'> {
  if (ratio === null || !Number.isFinite(ratio)) return 'none';
  const z = cfgOf(ctx).acwr.zones;
  if (ratio < z.lowBelow) return 'low';
  if (ratio <= z.greenMax) return 'green';
  if (ratio <= z.orangeMax) return 'orange';
  return 'red';
}

/** Daily seed loads derived from the onboarding "typical week". */
export function coldStartDailySeed(seed: ColdStartSeed | null, metric: LoadMetric, ctx: { config?: Thresholds } = {}): number {
  if (!seed) return 0;
  const c = cfgOf(ctx).fingerLoad;
  if (metric === 'global') return (seed.sessionsPerWeek * seed.avgDurationMin * seed.avgSessionRPE) / 7;
  const fingerWeekly = (seed.fingerSessionsPerWeek * seed.fingerMinutesPerSession * 60 * c.intensityFactor[seed.fingerIntensity]) / c.secondsPerUnit;
  // Restricted grips: no reliable seed; assume 10 % of finger load (coaching practice) so the cap is not zero.
  return metric === 'finger' ? fingerWeekly / 7 : (fingerWeekly * 0.1) / 7;
}

export interface AcwrPoint {
  date: ISODate;
  load: number;
  acute: number;
  chronic: number;
  ratio: number | null;
}

export interface AcwrResult {
  metric: LoadMetric;
  asOf: ISODate;
  acute: number;
  chronic: number;
  ratio: number | null;
  /** Zone shown to the user ('calibrating' during the first weeks). */
  zone: AcwrZone;
  /** Zone computed from the ratio regardless of calibration (for charts). */
  rawZone: Exclude<AcwrZone, 'calibrating'>;
  calibrating: boolean;
  daysOfData: number;
  series: AcwrPoint[];
}

export interface AcwrOptions {
  metric: LoadMetric;
  asOf: ISODate;
  coldStart: ColdStartSeed | null;
  /** Extra (e.g. planned) loads after asOf, for projections. */
  extra?: DatedLoad[];
  until?: ISODate;
  config?: Thresholds;
}

/**
 * EWMA ACWR. Series starts at the earliest of (cold-start date, first logged session).
 * With a cold start seed, both EWMAs start at the seed daily load (=> ratio ~1 at start).
 */
export function computeACWR(loads: DatedLoad[], opts: AcwrOptions): AcwrResult {
  const cfg = opts.config ?? defaultThresholds;
  const until = opts.until ?? opts.asOf;
  const all = [...loads.filter((l) => l.date <= opts.asOf), ...(opts.extra ?? []).filter((l) => l.date > opts.asOf && l.date <= until)];
  const firstLog = loads.reduce<ISODate | null>((m, l) => (m === null || l.date < m ? l.date : m), null);
  const candidates = [opts.coldStart?.seededAt, firstLog].filter((d): d is ISODate => !!d && d <= opts.asOf);
  const empty: AcwrResult = {
    metric: opts.metric, asOf: until, acute: 0, chronic: 0, ratio: null, zone: 'none', rawZone: 'none',
    calibrating: true, daysOfData: 0, series: [],
  };
  if (!candidates.length) return empty;
  const start = candidates.sort()[0];

  const seed = coldStartDailySeed(opts.coldStart, opts.metric, { config: cfg });
  const daily = dailySeries(all, start, until, opts.metric);
  const values = daily.map((d) => d.load);
  const acute = ewma(values, cfg.acwr.acuteDays, seed);
  const chronic = ewma(values, cfg.acwr.chronicDays, seed);
  const series: AcwrPoint[] = daily.map((d, i) => ({
    date: d.date,
    load: d.load,
    acute: round1(acute[i]),
    chronic: round1(chronic[i]),
    ratio: chronic[i] > 1e-6 ? Math.round((acute[i] / chronic[i]) * 100) / 100 : null,
  }));
  const last = series[series.length - 1];
  const daysOfData = diffDays(start, opts.asOf) + 1;
  const calibrating = daysOfData < cfg.acwr.calibrationDays;
  const rawZone = zoneFor(last.ratio, { config: cfg });
  return {
    metric: opts.metric,
    asOf: until,
    acute: last.acute,
    chronic: last.chronic,
    ratio: last.ratio,
    zone: calibrating && rawZone !== 'none' ? 'calibrating' : rawZone,
    rawZone,
    calibrating,
    daysOfData,
    series,
  };
}

/* ------------------------------------------------------------------ */
/* Weekly totals, week-on-week change, caps                            */
/* ------------------------------------------------------------------ */

export interface WeekTotals {
  weekStart: ISODate;
  global: number;
  finger: number;
  restricted: number;
  sessions: number;
}

export function weekTotals(loads: DatedLoad[], weekStart: ISODate): WeekTotals {
  const ws = startOfWeek(weekStart);
  const end = addDays(ws, 6);
  const inWeek = loads.filter((l) => l.date >= ws && l.date <= end);
  return {
    weekStart: ws,
    global: Math.round(inWeek.reduce((s, l) => s + l.globalLoad, 0)),
    finger: round1(inWeek.reduce((s, l) => s + l.fingerLoad, 0)),
    restricted: round1(inWeek.reduce((s, l) => s + l.restrictedGripLoad, 0)),
    sessions: inWeek.length,
  };
}

/** Weekly bars for the last `weeks` weeks ending with the week of `asOf`. */
export function weeklyBars(loads: DatedLoad[], asOf: ISODate, weeks: number): WeekTotals[] {
  const thisWeek = startOfWeek(asOf);
  const out: WeekTotals[] = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(weekTotals(loads, addDays(thisWeek, -7 * i)));
  return out;
}

export interface WeekOnWeek {
  current: WeekTotals;
  previous: WeekTotals;
  /** % change; null when the previous week is below the minimum baseline. */
  globalPct: number | null;
  fingerPct: number | null;
  globalFlag: boolean;
  fingerFlag: boolean;
}

const pctChange = (cur: number, prev: number, minBase: number) => (prev < minBase ? null : Math.round(((cur - prev) / prev) * 1000) / 10);

/**
 * Week-on-week change. During cold start the "previous week" falls back to the seeded
 * typical week when no previous logs exist, so the first real week is still checked.
 */
export function weekOnWeek(loads: DatedLoad[], weekStart: ISODate, coldStart: ColdStartSeed | null, config: Thresholds = defaultThresholds): WeekOnWeek {
  const current = weekTotals(loads, weekStart);
  let previous = weekTotals(loads, addDays(current.weekStart, -7));
  if (previous.sessions === 0 && coldStart) {
    previous = {
      ...previous,
      global: Math.round(coldStartDailySeed(coldStart, 'global', { config }) * 7),
      finger: round1(coldStartDailySeed(coldStart, 'finger', { config }) * 7),
      restricted: round1(coldStartDailySeed(coldStart, 'restricted', { config }) * 7),
    };
  }
  const w = config.weekOnWeek;
  const globalPct = pctChange(current.global, previous.global, w.minBaselineForPctFlag);
  const fingerPct = pctChange(current.finger, previous.finger, w.minBaselineForPctFlag);
  return {
    current,
    previous,
    globalPct,
    fingerPct,
    globalFlag: globalPct !== null && globalPct > w.globalFlagPct,
    fingerFlag: fingerPct !== null && fingerPct > w.fingerFlagPct,
  };
}

export interface FingerCaps {
  /** Max finger load allowed for the target week (FLU). */
  weeklyFingerCap: number;
  /** Max restricted-grip load allowed for the target week (FLU). */
  weeklyRestrictedCap: number;
  basis: 'previous_week' | 'chronic' | 'cold_start';
}

/**
 * A2 protection caps for a target week:
 *   fingerCap = max(previous week, chronic EWMA x 7 [or cold-start weekly]) x (1 + increaseCap%)
 * Using the chronic level means returning to normal after a deload week is allowed,
 * while true spikes above the habitual level are capped at +10 %.
 *   restrictedCap = min(maxShare% x fingerCap, max(prev restricted, chronic restricted x 7) x (1 + cap%)),
 *   with a floor of 5 % of fingerCap so pockets can be (re)introduced progressively.
 */
export function fingerCapsForWeek(
  loads: DatedLoad[],
  targetWeekStart: ISODate,
  coldStart: ColdStartSeed | null,
  config: Thresholds = defaultThresholds,
): FingerCaps {
  const ws = startOfWeek(targetWeekStart);
  const prev = weekTotals(loads, addDays(ws, -7));
  const dayBefore = addDays(ws, -1);
  const finger = computeACWR(loads, { metric: 'finger', asOf: dayBefore, coldStart, config });
  const restr = computeACWR(loads, { metric: 'restricted', asOf: dayBefore, coldStart, config });
  const seedWeekly = coldStartDailySeed(coldStart, 'finger', { config }) * 7;

  let base = prev.finger;
  let basis: FingerCaps['basis'] = 'previous_week';
  const chronicWeekly = finger.chronic * 7;
  if (!finger.calibrating && chronicWeekly > base) {
    base = chronicWeekly;
    basis = 'chronic';
  }
  if (finger.calibrating && seedWeekly > base) {
    base = seedWeekly;
    basis = 'cold_start';
  }
  const inc = 1 + config.weekOnWeek.fingerIncreaseCapPct / 100;
  const weeklyFingerCap = round1(base * inc);

  const rBase = Math.max(prev.restricted, restr.chronic * 7);
  const r = config.restrictedGrips;
  const weeklyRestrictedCap = round1(
    Math.max(
      weeklyFingerCap * 0.05,
      Math.min((r.maxShareOfFingerLoadPct / 100) * weeklyFingerCap, rBase * (1 + r.weeklyIncreaseCapPct / 100)),
    ),
  );
  return { weeklyFingerCap, weeklyRestrictedCap, basis };
}

/* ------------------------------------------------------------------ */
/* Projection (pre-emptive warning)                                    */
/* ------------------------------------------------------------------ */

export interface Projection {
  global: AcwrResult;
  finger: AcwrResult;
  /** Highest projected ratio over the window (asOf..until] and its date. */
  peakGlobal: { date: ISODate; ratio: number } | null;
  peakFinger: { date: ISODate; ratio: number } | null;
  warning: boolean;
}

export function plannedToDatedLoads(planned: PlannedSession[], ctx: LoadContext): DatedLoad[] {
  return planned
    .filter((p) => p.status === 'planned')
    .map((p) => {
      const e = estimatePlannedSession(p, ctx);
      return { date: p.date, globalLoad: e.globalLoad, fingerLoad: p.estFingerLoad || e.fingerLoad, restrictedGripLoad: e.restrictedGripLoad };
    });
}

/**
 * Project ACWR forward with planned sessions. `asOf` = last day with real logs (usually yesterday,
 * or today if today's session is already logged). Planned sessions dated after asOf are added.
 */
export function projectACWR(
  loads: DatedLoad[],
  planned: DatedLoad[],
  asOf: ISODate,
  until: ISODate,
  coldStart: ColdStartSeed | null,
  config: Thresholds = defaultThresholds,
): Projection {
  const global = computeACWR(loads, { metric: 'global', asOf, until, extra: planned, coldStart, config });
  const finger = computeACWR(loads, { metric: 'finger', asOf, until, extra: planned, coldStart, config });
  const peak = (r: AcwrResult) =>
    r.series
      .filter((p) => p.date > asOf && p.ratio !== null)
      .reduce<{ date: ISODate; ratio: number } | null>((m, p) => (m === null || (p.ratio as number) > m.ratio ? { date: p.date, ratio: p.ratio as number } : m), null);
  const peakGlobal = peak(global);
  const peakFinger = peak(finger);
  const orange = config.acwr.zones.greenMax;
  const calibrating = global.calibrating;
  const warning = !calibrating && ((peakGlobal?.ratio ?? 0) > orange || (peakFinger?.ratio ?? 0) > orange);
  return { global, finger, peakGlobal, peakFinger, warning };
}
