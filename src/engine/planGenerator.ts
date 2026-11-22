/**
 * PLAN GENERATOR (rule-based, deterministic apart from ids).
 *
 * 1. Macro: block periodisation (strength -> power -> performance, each ending with a deload
 *    + re-test). With a target date the macro is built BACKWARDS (taper last). Projecting phases
 *    inserted by the user overwrite the weeks they cover. Newborn / low-capacity modes replace
 *    the sequence with newborn / maintenance blocks; leaving newborn mode starts a return ramp.
 * 2. Detail: only the current block is detailed, week by week, from JSON templates
 *    (src/config/plan-templates.json), with loads prescribed from the latest benchmarks.
 * 3. Safety: finger warm-up auto-inserted, cool-down appended, recovery rules enforced by the
 *    day scheduler (planRules.ts), weekly finger and restricted-grip caps (load.ts) enforced by
 *    trimming the least important finger items.
 */
import {
  planTemplates as defaultTemplates,
  rules as defaultRules,
  thresholds as defaultThresholds,
  type PlanTemplates,
  type Rules,
  type RxKey,
  type SessionTemplate,
  type TemplateItem,
  type Thresholds,
} from '../config';
import { addDays, diffDays, nowISO, startOfWeek, weekdayIndex, type ISODate } from '../lib/dates';
import { newId } from '../lib/ids';
import {
  RESTRICTED_GRIPS,
  type BenchmarkResult,
  type BlockKind,
  type ExerciseDef,
  type LoadMode,
  type MacroBlock,
  type Plan,
  type PlannedItem,
  type PlannedSession,
  type PlanWeek,
  type ProfileEntry,
  type Settings,
} from '../data/schema';
import type { Domain, WeaknessRanking } from './assessment';
import { estimate1RMAdded } from './assessment';
import { benchmarkValue, latestBenchmarks, type Library } from './library';
import { estimatePlannedSession, fingerCapsForWeek, plannedItemFingerLoad, type DatedLoad, type LoadContext } from './load';
import { checkRules, isHigh, maxIntensity } from './planRules';

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface InsertedPhase {
  kind: 'projecting';
  start: ISODate;
  weeks: number;
}

export interface WeekOverrides {
  unavailableDays?: ISODate[];
  outdoorDays?: ISODate[];
}

export interface GeneratorInput {
  today: ISODate;
  profile: ProfileEntry;
  settings: Settings;
  benchmarks: BenchmarkResult[];
  ranking: WeaknessRanking;
  /** Logged loads (for caps). */
  loads: DatedLoad[];
  library: Library;
  ctx: LoadContext;
  hasTindeq: boolean;
  phases?: InsertedPhase[];
  /** Per-week overrides keyed by Monday date. */
  overrides?: Record<ISODate, WeekOverrides>;
  /** Number of completed macro cycles (enables 2-finger pockets etc. later). */
  cycleIndex?: number;
  previous?: Plan;
  rules?: Rules;
  templates?: PlanTemplates;
  thresholds?: Thresholds;
}

/* ------------------------------------------------------------------ */
/* Macro                                                               */
/* ------------------------------------------------------------------ */

const TRAINING_BLOCKS: BlockKind[] = ['strength', 'power', 'power_endurance', 'performance'];

function mkBlock(kind: BlockKind, startDate: ISODate, weeks: number, focus: string[], userInserted = false): MacroBlock {
  const training = TRAINING_BLOCKS.includes(kind);
  return {
    id: newId(),
    kind,
    startDate,
    weeks,
    deloadWeekIndex: training && weeks >= 4 ? weeks - 1 : null,
    focus,
    retestAtEnd: training,
    userInserted,
  };
}

/** Plans start on a Monday: this week if today is Mon-Wed, otherwise next Monday. */
export function planStartDate(today: ISODate): ISODate {
  const mon = startOfWeek(today);
  return weekdayIndex(today) <= 2 ? mon : addDays(mon, 7);
}

export interface MacroInput {
  start: ISODate;
  targetDate: ISODate | null;
  mode: Settings['mode'];
  phases: InsertedPhase[];
  focus: string[];
  rules?: Rules;
}

export function buildMacro(inp: MacroInput): MacroBlock[] {
  const r = (inp.rules ?? defaultRules).macro;
  const focus = inp.focus;
  const blocks: MacroBlock[] = [];
  const horizonEnd = inp.targetDate ? addDays(startOfWeek(inp.targetDate), 7) : addDays(inp.start, r.defaultHorizonWeeks * 7);
  const totalWeeks = Math.max(1, Math.round(diffDays(inp.start, horizonEnd) / 7));

  if (inp.mode === 'newborn' || inp.mode === 'low_capacity') {
    const kind: BlockKind = inp.mode === 'newborn' ? 'newborn' : 'maintenance';
    const len = inp.mode === 'newborn' ? r.newbornBlockWeeks : r.maintenanceBlockWeeks;
    for (let w = 0; w < totalWeeks; w += len) {
      blocks.push(mkBlock(kind, addDays(inp.start, w * 7), Math.min(len, totalWeeks - w), focus));
    }
    return blocks;
  }

  let cursor = inp.start;
  let remaining = totalWeeks;
  if (inp.mode === 'return_ramp') {
    const rw = Math.min((inp.rules ?? defaultRules).modes.return_ramp.weeks, remaining);
    blocks.push(mkBlock('return_ramp', cursor, rw, focus));
    cursor = addDays(cursor, rw * 7);
    remaining -= rw;
  }

  if (inp.targetDate && remaining > 0) {
    // Backwards: taper, then cycle reversed.
    const rev: { kind: BlockKind; weeks: number }[] = [{ kind: 'taper', weeks: Math.min(r.taperWeeks, remaining) }];
    let left = remaining - rev[0].weeks;
    const cyc = [...r.cycle].reverse() as { kind: BlockKind; weeks: number }[];
    let i = 0;
    while (left >= r.minBlockWeeks) {
      const c = cyc[i % cyc.length];
      const w = Math.min(c.weeks, left);
      rev.push({ kind: c.kind, weeks: w });
      left -= w;
      i++;
    }
    if (left > 0) {
      // Leftover < minBlockWeeks: extend the earliest block up to maxBlockWeeks, rest -> maintenance.
      const first = rev[rev.length - 1];
      const add = Math.min(left, r.maxBlockWeeks - first.weeks);
      first.weeks += add;
      left -= add;
      if (left > 0) rev.push({ kind: 'maintenance', weeks: left });
    }
    for (const b of rev.reverse()) {
      blocks.push(mkBlock(b.kind, cursor, b.weeks, focus));
      cursor = addDays(cursor, b.weeks * 7);
    }
  } else {
    let i = 0;
    while (remaining > 0) {
      const c = r.cycle[i % r.cycle.length] as { kind: BlockKind; weeks: number };
      const w = Math.min(c.weeks, remaining);
      blocks.push(mkBlock(w < r.minBlockWeeks ? 'maintenance' : c.kind, cursor, w, focus));
      cursor = addDays(cursor, w * 7);
      remaining -= w;
      i++;
    }
  }
  return insertPhases(blocks, inp.phases, focus, inp.rules ?? defaultRules);
}

/** Projecting phases overwrite the weeks they cover; partial blocks are truncated (kept if ≥ 2 weeks). */
export function insertPhases(blocks: MacroBlock[], phases: InsertedPhase[], focus: string[], r: Rules = defaultRules): MacroBlock[] {
  let out = [...blocks];
  for (const ph of [...phases].sort((a, b) => a.start.localeCompare(b.start))) {
    const ps = startOfWeek(ph.start);
    const pe = addDays(ps, ph.weeks * 7);
    const next: MacroBlock[] = [];
    let inserted = false;
    for (const b of out) {
      const bs = b.startDate;
      const be = addDays(bs, b.weeks * 7);
      if (be <= ps || bs >= pe) {
        if (!inserted && bs >= pe) {
          next.push(mkBlock('projecting', ps, ph.weeks, focus, true));
          inserted = true;
        }
        next.push(b);
        continue;
      }
      const headWeeks = Math.max(0, diffDays(bs, ps) / 7);
      if (headWeeks >= 2) next.push({ ...mkBlock(b.kind, bs, headWeeks, b.focus, b.userInserted), id: b.id });
      if (!inserted) {
        next.push(mkBlock('projecting', ps, ph.weeks, focus, true));
        inserted = true;
      }
      const tailWeeks = Math.max(0, diffDays(pe, be) / 7);
      if (tailWeeks >= r.macro.minBlockWeeks) next.push(mkBlock(b.kind, pe, tailWeeks, b.focus, b.userInserted));
    }
    if (!inserted) next.push(mkBlock('projecting', ps, ph.weeks, focus, true));
    out = next;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Load prescriptions                                                  */
/* ------------------------------------------------------------------ */

export interface RxContext {
  bm: number;
  maxHangAdded: number | null;
  pullup1RMAdded: number | null;
  repeatersRemoved: number | null;
  peakForcePerHand: number | null;
}

export function rxContext(profile: ProfileEntry, benchmarks: BenchmarkResult[]): RxContext {
  const latest = latestBenchmarks(benchmarks);
  const bm = profile.bodyMassKg;
  const pull = latest.get('weighted_pullup');
  const l = benchmarkValue(latest, 'tindeq_peak_force', 'left');
  const rr = benchmarkValue(latest, 'tindeq_peak_force', 'right');
  const both = benchmarkValue(latest, 'tindeq_peak_force');
  const peaks = [l, rr].filter((x): x is number => x !== null);
  return {
    bm,
    maxHangAdded: benchmarkValue(latest, 'max_hang_20mm_10s_hc'),
    pullup1RMAdded: pull ? estimate1RMAdded(pull.value, pull.reps ?? 1, pull.bodyMassKg || bm) : null,
    repeatersRemoved: benchmarkValue(latest, 'repeaters_7_3_20mm'),
    peakForcePerHand: peaks.length ? Math.min(...peaks) : both,
  };
}

const r05 = (x: number) => Math.round(x * 2) / 2;

export interface Prescription {
  mode: LoadMode;
  value: number | null;
  note?: string;
}

/**
 * Load for a prescription key. `pct` = block intensity (strength ramp / maintenance);
 * `intF` = extra intensity factor (deload, readiness downgrade).
 */
export function prescribeLoad(rx: RxKey | undefined, ex: ExerciseDef, c: RxContext, pct: number, intF: number, r: Rules = defaultRules): Prescription {
  const p = r.progression;
  const ref = c.maxHangAdded === null ? null : c.bm + c.maxHangAdded;
  const perHand = c.peakForcePerHand ?? (ref !== null ? ref / 2 : null);
  const missing = (mode: LoadMode): Prescription => ({ mode, value: null, note: 'Set after the first test (or enter a load manually).' });
  switch (rx) {
    case 'max_hang':
    case 'max_hang_maint':
      return ref === null ? missing('added_kg') : { mode: 'added_kg', value: r05(ref * pct * intF - c.bm) };
    case 'max_hang_open':
      return ref === null ? missing('added_kg') : { mode: 'added_kg', value: r05(ref * pct * p.openHandFactor * intF - c.bm) };
    case 'min_edge':
      return { mode: 'bodyweight', value: null };
    case 'one_arm':
      return ref === null ? missing('removed_kg') : { mode: 'removed_kg', value: Math.max(0, r05(c.bm - (ref / 2) * p.oneArmFactor * intF)) };
    case 'nohang':
      return perHand === null ? missing('target_force_kg') : { mode: 'target_force_kg', value: r05(perHand * p.noHangPctOfMax * intF) };
    case 'tendon_iso':
      return { mode: 'target_force_kg', value: r05((perHand ?? c.bm * 0.6) * p.tendonIsoPctOfMax) };
    case 'pocket3':
    case 'pocket2': {
      if (ref === null) return { mode: 'removed_kg', value: r05(c.bm * (rx === 'pocket3' ? 0.4 : 0.55)), note: 'Conservative default assistance until tested.' };
      const f = rx === 'pocket3' ? p.pocket3fFactor : p.pocket2fFactor;
      return { mode: 'removed_kg', value: Math.max(0, r05(c.bm - ref * f * intF)) };
    }
    case 'repeaters': {
      let removed: number | null = null;
      if (c.repeatersRemoved !== null) removed = c.repeatersRemoved + (p.repeatersExtraAssistPctBW / 100) * c.bm;
      else if (ref !== null) removed = Math.max(0, c.bm - ref * p.repeatersDefaultPctOfMax);
      if (removed === null) return missing('removed_kg');
      return { mode: 'removed_kg', value: Math.max(0, r05(c.bm - (c.bm - removed) * intF)) };
    }
    case 'pullup':
      return c.pullup1RMAdded === null ? missing('added_kg') : { mode: 'added_kg', value: r05((c.bm + c.pullup1RMAdded) * p.pullupWorkPctOf1RM * intF - c.bm) };
    case 'finger_curls':
      return { mode: 'added_kg', value: p.fingerCurlsDefaultKg };
    case 'bw':
      return { mode: 'bodyweight', value: null };
    case 'bw_added0':
      return { mode: 'added_kg', value: 0 };
    default:
      return { mode: ex.loadMode, value: null };
  }
}

/* ------------------------------------------------------------------ */
/* Session materialisation                                             */
/* ------------------------------------------------------------------ */

export interface WeekParams {
  block: MacroBlock;
  weekIndex: number;
  isDeload: boolean;
  /** 1 = normal; deload/return ramp < 1. */
  volume: number;
  intensity: number;
  /** Block intensity for max-hang style prescriptions. */
  pct: number;
  maintPct: number;
  top: Domain[];
  hasTindeq: boolean;
  cycleIndex: number;
}

const FINGER_CATS = new Set(['finger', 'power', 'test']);

function materialiseItem(t: TemplateItem, lib: Library, rx: RxContext, wp: WeekParams, r: Rules): PlannedItem | null {
  const ex = lib.get(t.ex);
  if (!ex) return null;
  if (t.fromWeek !== undefined && wp.weekIndex < t.fromWeek && wp.cycleIndex === 0) return null;
  if (t.requires === 'tindeq' && !wp.hasTindeq) return null;
  if (t.weakness && !wp.top.includes(t.weakness as Domain)) return null;
  if (wp.isDeload && (t.priority ?? 1) >= 4 && ex.fingerIntensity !== 'none') return null; // drop least important finger items in deload
  const base = ex.timer;
  const sets = Math.max(1, Math.round((t.sets ?? base.sets) * (ex.category === 'test' ? 1 : wp.volume)));
  const totalS = t.totalS ?? base.totalS;
  const timer = {
    ...base,
    sets,
    reps: t.reps ?? base.reps,
    ...(totalS !== undefined ? { totalS: Math.round((totalS * (ex.category === 'test' ? 1 : Math.max(0.5, wp.volume))) / 60) * 60 } : {}),
  };
  const isMaint = t.rx === 'max_hang_maint';
  const pres = prescribeLoad(t.rx, ex, rx, isMaint ? wp.maintPct : wp.pct, wp.intensity, r);
  return {
    id: newId(),
    exerciseId: ex.id,
    role: t.role,
    timer,
    load: { mode: pres.mode, value: pres.value },
    grip: t.grip ?? ex.defaultGrip,
    edgeMm: ex.edgeMm,
    rpeTarget: ex.category === 'test' ? 10 : wp.isDeload ? 6 : ex.fingerIntensity === 'max' ? 8 : 7,
    notes: pres.note,
  };
}

function warmupItems(tpl: SessionTemplate, items: PlannedItem[], lib: Library): PlannedItem[] {
  const needsFinger = items.some((i) => {
    const e = lib.get(i.exerciseId);
    return !!e && FINGER_CATS.has(e.category) && ['moderate', 'high', 'max'].includes(e.fingerIntensity);
  });
  const ids: string[] = [];
  if (tpl.warmup === 'finger_only' || tpl.location === 'home') {
    if (needsFinger) ids.push('finger_warmup_ramp');
  } else {
    ids.push('general_warmup', 'climb_warmup_easy');
    if (needsFinger) ids.push('finger_warmup_ramp');
  }
  return ids
    .map((id) => lib.get(id))
    .filter((e): e is ExerciseDef => !!e)
    .map((e) => ({ id: newId(), exerciseId: e.id, role: 'warmup' as const, timer: { ...e.timer }, load: { mode: e.loadMode, value: null }, grip: e.defaultGrip, edgeMm: e.edgeMm }));
}

function cooldownItem(lib: Library): PlannedItem[] {
  const e = lib.get('cooldown_easy');
  return e ? [{ id: newId(), exerciseId: e.id, role: 'cooldown', timer: { ...e.timer }, load: { mode: 'none', value: null } }] : [];
}

export function buildSession(
  tpl: SessionTemplate,
  date: ISODate,
  lib: Library,
  rx: RxContext,
  wp: WeekParams,
  ctx: LoadContext,
  r: Rules = defaultRules,
  priorities?: Map<string, number>,
): PlannedSession {
  const main = tpl.items.map((t) => {
    const it = materialiseItem(t, lib, rx, wp, r);
    if (it && priorities) priorities.set(it.id, t.priority ?? 1);
    return it;
  }).filter((x): x is PlannedItem => !!x);
  const items = tpl.kind === 'prehab' ? main : [...warmupItems(tpl, main, lib), ...main, ...cooldownItem(lib)];
  const fi = maxIntensity(main.map((i) => lib.get(i.exerciseId)?.fingerIntensity ?? 'none'));
  const dur = Math.round(tpl.durationMin * (tpl.kind === 'test' ? 1 : Math.max(0.6, wp.volume)));
  const s: PlannedSession = {
    id: newId(),
    date,
    kind: tpl.kind,
    title: tpl.title + (wp.isDeload && tpl.kind !== 'test' && tpl.kind !== 'prehab' ? ' (deload)' : ''),
    estDurationMin: dur,
    estSessionRPE: wp.isDeload ? Math.max(3, tpl.sessionRPE - 2) : tpl.sessionRPE,
    fingerIntensity: fi,
    estFingerLoad: 0,
    location: tpl.location,
    items,
    status: 'planned',
    optional: tpl.optional,
  };
  s.estFingerLoad = estimatePlannedSession(s, ctx).fingerLoad;
  return s;
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

/**
 * Assign sessions (ordered by importance) to weekday indices. Brute force over permutations
 * (≤ 4 sessions x 7 days), maximising preferred-day matches and spacing, subject to rules.
 * `fixed` = sessions whose day is already set (outdoor days). Returns null if impossible.
 */
export function assignDays(
  sessions: Pick<PlannedSession, 'fingerIntensity'>[],
  available: number[],
  preferred: number[],
  fixed: { day: number; fingerIntensity: PlannedSession['fingerIntensity'] }[],
  prevWeekLastDayHigh: boolean,
  r: Rules = defaultRules,
): number[] | null {
  const minMax = r.recovery.minDaysBetweenMaxFinger;
  let best: { days: number[]; score: number } | null = null;
  const fixedDays = new Set(fixed.map((f) => f.day));
  const avail = available.filter((d) => !fixedDays.has(d));
  const cur: number[] = [];
  const high = (i: PlannedSession['fingerIntensity']) => i === 'high' || i === 'max';

  const ok = (): boolean => {
    const all = [...fixed.map((f) => ({ day: f.day, fi: f.fingerIntensity })), ...cur.map((d, i) => ({ day: d, fi: sessions[i].fingerIntensity }))].sort((a, b) => a.day - b.day);
    for (let i = 0; i < all.length; i++) {
      if (i === 0 && prevWeekLastDayHigh && all[i].day === 0 && high(all[i].fi)) return false;
      for (let j = i + 1; j < all.length; j++) {
        const gap = all[j].day - all[i].day;
        if (gap === 0) return false;
        if (gap === 1 && r.recovery.noBackToBackHighFinger && high(all[i].fi) && high(all[j].fi)) return false;
        if (gap < minMax && all[i].fi === 'max' && all[j].fi === 'max') return false;
      }
    }
    return true;
  };
  const score = () => {
    const days = [...cur, ...fixed.map((f) => f.day)].sort((a, b) => a - b);
    let s = cur.reduce((acc, d, i) => acc + (preferred.includes(d) ? 10 - i : 0), 0);
    for (let i = 1; i < days.length; i++) s += Math.min(days[i] - days[i - 1], 3); // spread sessions
    return s;
  };
  const rec = (i: number) => {
    if (i === sessions.length) {
      const sc = score();
      if (!best || sc > best.score) best = { days: [...cur], score: sc };
      return;
    }
    for (const d of avail) {
      if (cur.includes(d)) continue;
      cur.push(d);
      if (ok()) rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return best ? (best as { days: number[] }).days : null;
}

/* ------------------------------------------------------------------ */
/* Week builder                                                        */
/* ------------------------------------------------------------------ */

function templatesFor(kind: BlockKind, count: number, T: PlanTemplates): SessionTemplate[] {
  const key = T.aliases[kind] ?? kind;
  const bt = T.blocks[key] ?? T.blocks.strength;
  const pick = (n: number): SessionTemplate[] | null => {
    const v = bt[String(n)];
    if (Array.isArray(v)) return v;
    if (v === '3+free') {
      const three = bt['3'];
      return Array.isArray(three) ? [...three, T.freeSession] : null;
    }
    return null;
  };
  for (const n of [count, 3, 2, 4]) {
    const t = pick(n);
    if (t) return n === count ? t : n > count ? t.slice(0, count) : t;
  }
  return [];
}

export interface BuildWeekInput {
  block: MacroBlock;
  weekIndex: number;
  weekStart: ISODate;
  isFirstPlanWeek: boolean;
  settings: Settings;
  overrides?: WeekOverrides;
  lib: Library;
  rx: RxContext;
  ctx: LoadContext;
  top: Domain[];
  hasTindeq: boolean;
  cycleIndex: number;
  /** Loads used for cap computation (logs + previously planned weeks). */
  capLoads: DatedLoad[];
  prevWeekLastDayHigh: boolean;
  rules?: Rules;
  templates?: PlanTemplates;
  thresholds?: Thresholds;
}

export function sessionsPerWeekFor(settings: Settings, r: Rules = defaultRules): number {
  if (settings.mode === 'low_capacity') return Math.min(settings.sessionsPerWeek, r.modes.low_capacity.sessionsPerWeek);
  if (settings.mode === 'newborn') return r.modes.newborn.sessionsPerWeek;
  return Math.max(1, Math.min(4, settings.sessionsPerWeek));
}

export function buildWeek(inp: BuildWeekInput): PlanWeek {
  const r = inp.rules ?? defaultRules;
  const T = inp.templates ?? defaultTemplates;
  const { block, weekIndex, weekStart, lib } = inp;
  const notes: string[] = [];
  const isDeload = block.deloadWeekIndex === weekIndex;
  const rampVol = block.kind === 'return_ramp' ? r.modes.return_ramp.volume[Math.min(weekIndex, r.modes.return_ramp.volume.length - 1)] : 1;
  const ramp = r.progression.strengthBlockRamp;
  const strengthLike = block.kind === 'strength' || block.kind === 'return_ramp';
  const wp: WeekParams = {
    block,
    weekIndex,
    isDeload,
    volume: (isDeload ? r.deload.volumeFactor : 1) * rampVol,
    intensity: isDeload ? r.deload.intensityFactor : block.kind === 'return_ramp' ? Math.min(1, 0.8 + 0.05 * weekIndex) : 1,
    pct: strengthLike ? ramp[Math.min(weekIndex, ramp.length - 1)] : r.progression.maintenanceIntensity,
    maintPct: r.progression.maintenanceIntensity,
    top: inp.top,
    hasTindeq: inp.hasTindeq,
    cycleIndex: inp.cycleIndex,
  };

  const count = sessionsPerWeekFor(inp.settings, r);
  let tpls = templatesFor(block.kind, count, T).slice(0, count);
  if (block.kind === 'newborn' && count < 2) tpls = tpls.slice(0, 1);

  // Tests: initial assessment (no max-hang benchmark yet) or re-test in the deload week.
  const needInitial = inp.isFirstPlanWeek && inp.rx.maxHangAdded === null && block.kind !== 'newborn';
  const retest = block.retestAtEnd && isDeload;
  if (needInitial || retest) {
    const idx = tpls.findIndex((t) => t.kind === 'training');
    if (idx >= 0) tpls[idx] = T.testSessions.a;
    const lastTraining = tpls.map((t, i) => ({ t, i })).reverse().find(({ t, i }) => i !== idx && (t.kind === 'training' || t.kind === 'projecting'));
    if (lastTraining) tpls[lastTraining.i] = T.testSessions.b;
    notes.push(needInitial ? 'Assessment week: first benchmarks will set your training loads.' : 'Deload week with end-of-block re-test.');
  }

  // Availability.
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const unavailable = new Set<ISODate>([
    ...(inp.overrides?.unavailableDays ?? []),
    ...weekDates.filter((d) => inp.settings.unavailableWeekdays.includes(weekdayIndex(d))),
  ]);
  const outdoorDates = (inp.overrides?.outdoorDays ?? []).filter((d) => weekDates.includes(d) && !unavailable.has(d));

  // Outdoor days replace the least important non-test sessions.
  const fixedSessions: PlannedSession[] = [];
  const projectingish = ['projecting', 'performance', 'power_endurance', 'taper'].includes(block.kind);
  for (const d of outdoorDates) {
    const tplOut = projectingish ? T.outdoorProjecting : T.outdoor;
    fixedSessions.push(buildSession(tplOut, d, lib, inp.rx, { ...wp, volume: 1 }, inp.ctx, r));
    const replaceIdx = [...tpls.keys()].reverse().find((i) => tpls[i].kind !== 'test' && !(tpls[i].kind === 'training' && i === 0));
    if (replaceIdx !== undefined && tpls.length > 1) tpls.splice(replaceIdx, 1);
    else if (tpls.length === 1 && tpls[0].kind !== 'test') tpls = [];
  }

  // Materialise remaining sessions (dates assigned below).
  const priorities = new Map<string, number>();
  let sessions = tpls.map((t) => buildSession(t, weekStart, lib, inp.rx, wp, inp.ctx, r, priorities));
  const bonus = block.kind === 'newborn' ? (T.blocks.newborn.bonus as SessionTemplate | undefined) : undefined;

  const available = [0, 1, 2, 3, 4, 5, 6].filter((i) => !unavailable.has(weekDates[i]));
  const fixed = fixedSessions.map((s) => ({ day: weekdayIndex(s.date), fingerIntensity: s.fingerIntensity }));
  let days = assignDays(sessions, available, inp.settings.preferredDays, fixed, inp.prevWeekLastDayHigh, r);
  while (!days && sessions.length) {
    // Could not satisfy recovery rules: drop the least important session.
    const dropped = sessions.pop()!;
    notes.push(`"${dropped.title}" dropped this week: not enough available days that respect recovery rules.`);
    days = assignDays(sessions, available, inp.settings.preferredDays, fixed, inp.prevWeekLastDayHigh, r);
  }
  sessions = sessions.map((s, i) => ({ ...s, date: weekDates[days![i]] }));
  sessions = [...sessions, ...fixedSessions].sort((a, b) => a.date.localeCompare(b.date));

  if (bonus) {
    const used = new Set(sessions.map((s) => s.date));
    const free = available.map((i) => weekDates[i]).filter((d) => !used.has(d));
    const pref = free.find((d) => weekdayIndex(d) >= 5) ?? free[free.length - 1];
    if (pref) sessions.push(buildSession(bonus, pref, lib, inp.rx, wp, inp.ctx, r));
  }

  // Prehab: 2 short finger-only slots, not on max-finger or outdoor days, preferring rest days.
  if (block.kind !== 'newborn') {
    const slots = r.recovery.prehabSlotsPerWeek;
    const busy = new Map(sessions.map((s) => [s.date, s]));
    const candidates = available
      .map((i) => weekDates[i])
      .filter((d) => {
        const s = busy.get(d);
        return !s || (s.fingerIntensity !== 'max' && s.location !== 'outdoor' && s.kind !== 'test');
      })
      .sort((a, b) => Number(busy.has(a)) - Number(busy.has(b)) || a.localeCompare(b));
    const chosen: ISODate[] = [];
    for (const d of candidates) {
      if (chosen.length >= slots) break;
      if (chosen.every((c) => Math.abs(diffDays(c, d)) >= 2)) chosen.push(d);
    }
    for (const d of candidates) if (chosen.length < slots && !chosen.includes(d)) chosen.push(d);
    for (const d of chosen) sessions.push(buildSession(T.prehab, d, lib, inp.rx, { ...wp, volume: 1 }, inp.ctx, r));
    sessions.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'prehab' ? 1 : -1));
  }

  // Finger caps (A2 protection).
  const caps = fingerCapsForWeek(inp.capLoads, weekStart, inp.settings.coldStart, inp.thresholds ?? defaultThresholds);
  const trimmed = enforceCaps(sessions, caps.weeklyFingerCap, caps.weeklyRestrictedCap, lib, inp.ctx, priorities);
  sessions = trimmed.sessions;
  notes.push(...trimmed.notes);

  const violations = checkRules(sessions, { unavailableDates: [...unavailable], rules: r });
  for (const v of violations) notes.push(`Rule check: ${v.message}`);

  return {
    id: newId(),
    blockId: block.id,
    index: weekIndex,
    startDate: weekStart,
    isDeload,
    unavailableDays: [...(inp.overrides?.unavailableDays ?? [])],
    outdoorDays: outdoorDates,
    sessions,
    validated: false,
    validatedAt: null,
    notes,
    caps: {
      finger: caps.weeklyFingerCap,
      restricted: caps.weeklyRestrictedCap,
      estFinger: Math.round(sum(sessions.filter((s) => !s.optional), (s) => s.estFingerLoad) * 10) / 10,
      estRestricted: Math.round(sum(sessions.filter((s) => !s.optional), (s) => estimatePlannedSession(s, inp.ctx).restrictedGripLoad) * 10) / 10,
    },
  };
}

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

/**
 * Trim finger items until the week's estimated finger load fits the cap.
 * Order: restricted grips first (if over the restricted cap), then the least important
 * (highest priority number), most loading items. Never trims tests, warm-ups or cool-downs.
 */
export function enforceCaps(
  sessions: PlannedSession[],
  fingerCap: number,
  restrictedCap: number,
  lib: Library,
  ctx: LoadContext,
  priorities: Map<string, number> = new Map(),
): { sessions: PlannedSession[]; notes: string[] } {
  const notes: string[] = [];
  let ss = sessions.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, timer: { ...i.timer } })) }));
  const est = () => ss.filter((s) => !s.optional).reduce((a, s) => {
    const e = estimatePlannedSession(s, ctx);
    return { f: a.f + e.fingerLoad, r: a.r + e.restrictedGripLoad };
  }, { f: 0, r: 0 });
  const candidates = (restrictedOnly: boolean) => {
    const out: { s: number; i: number; prio: number; flu: number }[] = [];
    ss.forEach((s, si) => {
      if (s.kind === 'test' || s.kind === 'prehab' || s.optional) return;
      s.items.forEach((it, ii) => {
        if (it.role === 'warmup' || it.role === 'cooldown' || it.role === 'prehab') return;
        const ex = lib.get(it.exerciseId);
        if (!ex || ex.fingerIntensity === 'none') return;
        const grip = it.grip ?? ex.defaultGrip;
        if (restrictedOnly && !(grip && RESTRICTED_GRIPS.includes(grip))) return;
        const flu = plannedItemFingerLoad(it, ctx).flu;
        if (flu <= 0) return;
        const prio = priorities.get(it.id) ?? (it.role === 'main' ? 2 : 3);
        // Priority-1 items are reduced but never removed (floor: 1 set / 10 min).
        const t = it.timer;
        const reducible = t.sets > 1 || (!!t.totalS && t.totalS > 600);
        if (prio <= 1 && !reducible) return;
        out.push({ s: si, i: ii, prio, flu });
      });
    });
    return out.sort((a, b) => b.prio - a.prio || b.flu - a.flu);
  };
  const reduce = (c: { s: number; i: number }) => {
    const it = ss[c.s].items[c.i];
    const t = it.timer;
    const name = lib.get(it.exerciseId)?.name ?? it.exerciseId;
    if (t.totalS && t.totalS > 300 && (t.kind === 'countdown' || t.kind === 'arc' || t.kind === 'emom')) {
      t.totalS = Math.round((t.totalS * 0.8) / 60) * 60;
      return `${name}: duration reduced to ${Math.round(t.totalS / 60)} min`;
    }
    if (t.sets > 1) {
      t.sets -= 1;
      return `${name}: ${t.sets} sets`;
    }
    ss[c.s].items.splice(c.i, 1);
    return `${name}: removed`;
  };
  // One note per trimmed exercise (its final state), not one per trimming step.
  const restrictedTrims = new Map<string, string>();
  const fingerTrims = new Map<string, string>();
  const key = (c: { s: number; i: number }) => `${ss[c.s].date}|${ss[c.s].items[c.i].exerciseId}`;
  let guard = 0;
  let e = est();
  while (e.r > restrictedCap && guard++ < 50) {
    const c = candidates(true)[0];
    if (!c) break;
    const k = key(c);
    restrictedTrims.set(k, `${ss[c.s].date} ${reduce(c)}`);
    e = est();
  }
  while (e.f > fingerCap && guard++ < 150) {
    const c = candidates(false)[0];
    if (!c) break;
    const k = key(c);
    fingerTrims.set(k, `${ss[c.s].date} ${reduce(c)}`);
    e = est();
  }
  for (const m of restrictedTrims.values()) notes.push(`Restricted-grip cap (${restrictedCap} FLU) — ${m}.`);
  for (const m of fingerTrims.values()) notes.push(`Finger-load cap (${fingerCap} FLU) — ${m}.`);
  if (e.f > fingerCap) notes.push(`Estimated finger load ${e.f.toFixed(1)} FLU still above cap ${fingerCap} FLU (tests / climbing only).`);
  ss = ss.map((s) => ({
    ...s,
    fingerIntensity: maxIntensity(s.items.filter((i) => i.role !== 'warmup' && i.role !== 'cooldown').map((i) => lib.get(i.exerciseId)?.fingerIntensity ?? 'none')),
    estFingerLoad: estimatePlannedSession(s, ctx).fingerLoad,
  }));
  return { sessions: ss, notes };
}

/* ------------------------------------------------------------------ */
/* Block & plan                                                        */
/* ------------------------------------------------------------------ */

export function toPlannedLoads(sessions: PlannedSession[], ctx: LoadContext): DatedLoad[] {
  return sessions
    .filter((s) => s.status === 'planned' && !s.optional)
    .map((s) => {
      const e = estimatePlannedSession(s, ctx);
      return { date: s.date, globalLoad: e.globalLoad, fingerLoad: e.fingerLoad, restrictedGripLoad: e.restrictedGripLoad };
    });
}

export function buildBlockWeeks(
  block: MacroBlock,
  inp: GeneratorInput,
  rx: RxContext,
  firstPlanWeekStart: ISODate,
  initialPrevLastDayHigh = false,
): PlanWeek[] {
  const weeks: PlanWeek[] = [];
  let capLoads = [...inp.loads];
  let prevHigh = initialPrevLastDayHigh;
  for (let w = 0; w < block.weeks; w++) {
    const ws = addDays(block.startDate, w * 7);
    const week = buildWeek({
      block,
      weekIndex: w,
      weekStart: ws,
      isFirstPlanWeek: ws === firstPlanWeekStart,
      settings: inp.settings,
      overrides: inp.overrides?.[ws],
      lib: inp.library,
      rx,
      ctx: inp.ctx,
      top: inp.ranking.top,
      hasTindeq: inp.hasTindeq,
      cycleIndex: inp.cycleIndex ?? 0,
      capLoads,
      prevWeekLastDayHigh: prevHigh,
      rules: inp.rules,
      templates: inp.templates,
      thresholds: inp.thresholds,
    });
    weeks.push(week);
    capLoads = [...capLoads, ...toPlannedLoads(week.sessions, inp.ctx)];
    const sunday = addDays(ws, 6);
    prevHigh = week.sessions.some((s) => s.date === sunday && isHigh(s) && s.kind !== 'prehab');
  }
  return weeks;
}

export function generatePlan(inp: GeneratorInput): Plan {
  const start = planStartDate(inp.today);
  const focus = inp.ranking.top;
  const phases = inp.phases ?? (inp.previous?.macro.filter((b) => b.userInserted && b.kind === 'projecting').map((b) => ({ kind: 'projecting' as const, start: b.startDate, weeks: b.weeks })) ?? []);
  const macro = buildMacro({ start, targetDate: inp.profile.goal.targetDate, mode: inp.settings.mode, phases, focus, rules: inp.rules });
  const rx = rxContext(inp.profile, inp.benchmarks);
  const current = macro[0];
  const weeks = buildBlockWeeks(current, inp, rx, start);
  const ts = nowISO();
  return {
    id: inp.previous?.id ?? newId(),
    createdAt: inp.previous?.createdAt ?? ts,
    updatedAt: ts,
    status: 'draft',
    version: (inp.previous?.version ?? 0) + 1,
    startDate: start,
    targetDate: inp.profile.goal.targetDate,
    macro,
    currentBlockIndex: 0,
    weeks,
    generatorInputsHash: hashInputs(inp),
  };
}

/** Detail the next macro block (called when the current block ends, after the re-test). */
export function advanceBlock(plan: Plan, inp: GeneratorInput): Plan {
  const nextIndex = plan.currentBlockIndex + 1;
  const block = plan.macro[nextIndex];
  if (!block) return plan;
  const rx = rxContext(inp.profile, inp.benchmarks);
  const lastWeek = plan.weeks[plan.weeks.length - 1];
  const sunday = lastWeek ? addDays(lastWeek.startDate, 6) : null;
  const prevHigh = !!lastWeek?.sessions.some((s) => s.date === sunday && isHigh(s) && s.kind !== 'prehab');
  const weeks = buildBlockWeeks(block, { ...inp, cycleIndex: inp.cycleIndex ?? Math.floor(nextIndex / 3) }, rx, plan.startDate, prevHigh);
  return { ...plan, currentBlockIndex: nextIndex, weeks, version: plan.version + 1, updatedAt: nowISO(), status: 'draft' };
}

function hashInputs(inp: GeneratorInput): string {
  const key = JSON.stringify({
    t: inp.today,
    bm: inp.profile.bodyMassKg,
    goal: inp.profile.goal,
    s: [inp.settings.sessionsPerWeek, inp.settings.mode, inp.settings.preferredDays, inp.settings.unavailableWeekdays],
    b: inp.benchmarks.filter((b) => !b.deleted).map((b) => [b.type, b.date, b.value]),
    top: inp.ranking.top,
  });
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
