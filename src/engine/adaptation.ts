/**
 * ADAPTATION ENGINE — turns signals into PROPOSALS. Nothing is applied until the user accepts;
 * applyProposal() then returns the new plan + a reason for the PlanVersion log.
 *
 * Rules (thresholds in config/adaptation-rules.json):
 *  - Missed session: reschedule to a later day of the SAME week if no recovery rule breaks
 *    and no other session is on that day (never stack); otherwise drop it.
 *  - Early deload: any `minTriggers` (2) of
 *      finger ACWR orange/red (or week-on-week finger flag while calibrating),
 *      readiness low ≥ 3 consecutive days, finger pain trend rising,
 *      sleep below baseline ≥ 3 nights, failed progression ≥ 2 times in 21 days.
 *  - Readiness: lighter variant / rest / finger downgrade for today's session.
 *  - Pain: amber -> modify, red -> stop that loading + rehab, red flag -> stop + see a physio.
 *  - Newborn mode suggestion from settings.newbornSuggestFrom; return ramp when leaving it.
 */
import { rules as defaultRules, type Rules } from '../config';
import { addDays, diffDays, nowISO, startOfWeek, type ISODate } from '../lib/dates';
import { newId } from '../lib/ids';
import {
  RESTRICTED_GRIPS,
  type Plan,
  type PlannedItem,
  type PlannedSession,
  type Proposal,
  type ProposalKind,
  type Settings,
  type TrainingMode,
} from '../data/schema';
import type { Library } from './library';
import type { AcwrResult, LoadContext, WeekOnWeek } from './load';
import { fingerPainTrendRising, locationLabel, protocolFor, type PainEvaluation } from './pain';
import type { PainEntry } from '../data/schema';
import { canPlace } from './planRules';
import { allSessions, findSession, refreshSession } from './planOps';
import { trailingRun, type ReadinessResult } from './readiness';

/* ------------------------------------------------------------------ */
/* Proposal helper                                                     */
/* ------------------------------------------------------------------ */

export type ProposalDraft = Omit<Proposal, 'createdAt' | 'updatedAt'>;

export function makeProposal(kind: ProposalKind, title: string, reason: string, triggers: string[], payload: Record<string, unknown>, expiresOn: ISODate | null): ProposalDraft {
  return { id: newId(), kind, status: 'pending', title, reason, triggers, payload, expiresOn, resolvedAt: null };
}

/* ------------------------------------------------------------------ */
/* Missed session                                                      */
/* ------------------------------------------------------------------ */

export function proposeForMissed(plan: Plan, sessionId: string, today: ISODate, unavailableWeekdays: number[] = [], r: Rules = defaultRules): ProposalDraft | null {
  const found = findSession(plan, sessionId);
  if (!found) return null;
  const { session, week } = found;
  if (session.kind === 'prehab' || session.optional) {
    return makeProposal('drop', `Drop "${session.title}"`, 'Short/optional slot — simply skip it.', ['missed'], { sessionId }, addDays(today, 2));
  }
  const weekEnd = addDays(week.startDate, 6);
  const others = allSessions(plan).filter((s) => s.id !== sessionId);
  const ctx = { unavailableDates: plan.weeks.flatMap((w) => w.unavailableDays), unavailableWeekdays, rules: r };
  const lastDay = r.recovery.rescheduleWithinWeekOnly ? weekEnd : addDays(weekEnd, 7);
  for (let d = addDays(today, 1); d <= lastDay; d = addDays(d, 1)) {
    if (others.some((o) => o.date === d && o.status === 'planned' && o.kind !== 'prehab')) continue; // never stack
    if (canPlace(session, d, others, ctx)) {
      return makeProposal(
        'reschedule',
        `Move "${session.title}" to ${d}`,
        `Missed on ${session.date}. ${d} respects recovery rules and has no other session.`,
        ['missed'],
        { sessionId, toDate: d },
        d,
      );
    }
  }
  return makeProposal(
    'drop',
    `Drop "${session.title}"`,
    'No day left this week that respects recovery rules without stacking sessions. Dropping is safer than cramming.',
    ['missed'],
    { sessionId },
    weekEnd,
  );
}

/** Planned sessions dated before today and not done -> missed candidates. */
export function detectMissed(plan: Plan, today: ISODate): PlannedSession[] {
  return allSessions(plan).filter((s) => s.status === 'planned' && s.date < today && !s.optional);
}

/* ------------------------------------------------------------------ */
/* Early deload                                                        */
/* ------------------------------------------------------------------ */

export interface DeloadSignals {
  fingerAcwr: AcwrResult;
  fingerWeekOnWeek: WeekOnWeek | null;
  readiness: ReadinessResult[]; // chronological, ending today
  pain: PainEntry[];
  failedProgressions: number; // in the rules window
  asOf: ISODate;
}

export function evaluateDeloadTriggers(sig: DeloadSignals, r: Rules = defaultRules): { triggers: string[]; propose: boolean } {
  const triggers: string[] = [];
  const z = sig.fingerAcwr.calibrating ? null : sig.fingerAcwr.rawZone;
  if (z === 'orange' || z === 'red') triggers.push(`Finger ACWR ${sig.fingerAcwr.ratio} (${z}).`);
  else if (sig.fingerAcwr.calibrating && sig.fingerWeekOnWeek?.fingerFlag) triggers.push(`Finger load +${sig.fingerWeekOnWeek.fingerPct} % week-on-week (calibrating).`);
  const lowRun = trailingRun(sig.readiness, (x) => x.advice === 'lighter' || x.advice === 'rest');
  if (lowRun >= r.deload.lowReadinessConsecutiveDays) triggers.push(`Low readiness ${lowRun} days in a row.`);
  if (fingerPainTrendRising(sig.pain, sig.asOf, r)) triggers.push('Finger pain trend rising.');
  const sleepRun = trailingRun(sig.readiness, (x) => x.sleepBelowBaseline);
  if (sleepRun >= r.deload.sleepBelowBaselineNights) triggers.push(`Sleep below baseline ${sleepRun} nights.`);
  if (sig.failedProgressions >= r.deload.failedProgressionCount) triggers.push(`Failed progression ${sig.failedProgressions} times recently.`);
  return { triggers, propose: triggers.length >= r.deload.minTriggers };
}

export function proposeDeload(plan: Plan, asOf: ISODate, triggers: string[]): ProposalDraft | null {
  // Deload the rest of this week if ≥ 3 days remain, else next week.
  const thisWeek = startOfWeek(asOf);
  const remaining = 7 - diffDays(thisWeek, asOf);
  const weekStart = remaining >= 3 ? thisWeek : addDays(thisWeek, 7);
  const w = plan.weeks.find((x) => x.startDate === weekStart);
  if (!w || w.isDeload) return null;
  return makeProposal(
    'deload',
    `Early deload (week of ${weekStart})`,
    'Two or more fatigue/risk signals at once. A lighter week now is cheaper than an injury.',
    triggers,
    { weekStart, fromDate: asOf },
    addDays(asOf, 3),
  );
}

/** Deload transform: half the sets, −15 % intensity, drop campus / 2-finger pockets / one-arm work. */
export function deloadSession(s: PlannedSession, lib: Library, ctx: LoadContext, r: Rules = defaultRules): PlannedSession {
  if (s.kind === 'test' || s.kind === 'prehab' || s.status !== 'planned') return s;
  const drop = new Set(['campus_ladders', 'pocket_hang_2f', 'one_arm_hang_assisted']);
  const items = s.items
    .filter((i) => !drop.has(i.exerciseId))
    .map((i) => scaleItem(i, r.deload.volumeFactor, r.deload.intensityFactor, ctx.bodyMassKg));
  return refreshSession({ ...s, items, title: s.title.includes('(deload)') ? s.title : `${s.title} (deload)`, estDurationMin: Math.round(s.estDurationMin * 0.7), estSessionRPE: Math.max(3, s.estSessionRPE - 2) }, lib, ctx);
}

/** Scale volume (sets / duration) and intensity (load) of an item. Warm-up/cool-down untouched. */
export function scaleItem(i: PlannedItem, volume: number, intensity: number, bodyMassKg: number): PlannedItem {
  if (i.role === 'warmup' || i.role === 'cooldown') return i;
  const timer = { ...i.timer, sets: Math.max(1, Math.round(i.timer.sets * volume)) };
  if (timer.totalS) timer.totalS = Math.round((timer.totalS * Math.max(0.5, volume)) / 60) * 60;
  let value = i.load.value;
  if (value !== null && intensity !== 1) {
    const r05 = (x: number) => Math.round(x * 2) / 2;
    if (i.load.mode === 'added_kg') value = r05((bodyMassKg + value) * intensity - bodyMassKg);
    else if (i.load.mode === 'removed_kg') value = Math.max(0, r05(bodyMassKg - (bodyMassKg - value) * intensity));
    else if (i.load.mode === 'target_force_kg') value = r05(value * intensity);
    else if (i.load.mode === 'percent_bw') value = Math.round(((100 + value) * intensity - 100) * 10) / 10;
  }
  return { ...i, timer, load: { ...i.load, value } };
}

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

export type DowngradeVariant = 'lighter' | 'rest' | 'finger_downgrade';

export function proposeForReadiness(plan: Plan, today: ISODate, rd: ReadinessResult): ProposalDraft | null {
  const s = allSessions(plan).find((x) => x.date === today && x.status === 'planned' && x.kind !== 'prehab');
  if (!s || rd.score === null) return null;
  if (rd.advice === 'rest') {
    return makeProposal('downgrade', `Rest instead of "${s.title}"`, rd.reasons.join(' '), ['readiness'], { sessionId: s.id, variant: 'rest' }, today);
  }
  if (rd.advice === 'lighter') {
    return makeProposal('downgrade', `Lighter version of "${s.title}"`, rd.reasons.join(' '), ['readiness'], { sessionId: s.id, variant: 'lighter' }, today);
  }
  if (rd.fingerLow && (s.fingerIntensity === 'high' || s.fingerIntensity === 'max')) {
    return makeProposal('downgrade', `Downgrade finger work in "${s.title}"`, rd.reasons.join(' '), ['finger_status'], { sessionId: s.id, variant: 'finger_downgrade' }, today);
  }
  return null;
}

export function downgradeSession(s: PlannedSession, variant: DowngradeVariant, lib: Library, ctx: LoadContext): PlannedSession {
  if (variant === 'rest') return { ...s, status: 'dropped' };
  if (variant === 'lighter') {
    const drop = new Set(['campus_ladders', 'pocket_hang_2f', 'one_arm_hang_assisted', 'limit_bouldering']);
    const items = s.items.filter((i) => !drop.has(i.exerciseId)).map((i) => scaleItem(i, 0.6, 0.9, ctx.bodyMassKg));
    return refreshSession({ ...s, items, title: `${s.title} (lighter)`, estDurationMin: Math.round(s.estDurationMin * 0.7), estSessionRPE: Math.max(3, s.estSessionRPE - 2) }, lib, ctx);
  }
  // finger_downgrade: replace high/max finger items with low-intensity tendon isometrics (once).
  let replaced = false;
  const items: PlannedItem[] = [];
  for (const i of s.items) {
    const ex = lib.get(i.exerciseId);
    const hard = ex && (ex.fingerIntensity === 'high' || ex.fingerIntensity === 'max') && i.role !== 'warmup' && i.role !== 'cooldown';
    if (!hard) {
      items.push(i);
      continue;
    }
    if (!replaced) {
      const iso = lib.get('tendon_iso_low');
      if (iso) items.push({ id: newId(), exerciseId: iso.id, role: 'main', timer: { ...iso.timer }, load: { mode: 'target_force_kg', value: Math.round(ctx.bodyMassKg * 0.2 * 2) / 2 }, grip: 'open_hand', notes: 'Replaces hard finger work (low finger status).' });
      replaced = true;
    }
  }
  return refreshSession({ ...s, items, title: `${s.title} (finger-light)` }, lib, ctx);
}

/* ------------------------------------------------------------------ */
/* Pain                                                                */
/* ------------------------------------------------------------------ */

export function proposeForPain(plan: Plan, evals: PainEvaluation[], asOf: ISODate, r: Rules = defaultRules): ProposalDraft[] {
  const out: ProposalDraft[] = [];
  const upcoming = allSessions(plan).filter((s) => s.status === 'planned' && s.date >= asOf && s.date <= addDays(asOf, 6));
  for (const e of evals) {
    const label = locationLabel(e.location);
    const finger = e.location.region === 'finger';
    const affected = upcoming.filter((s) => !finger || s.fingerIntensity !== 'none').map((s) => s.id);
    if (e.light === 'red_flag') {
      out.push(makeProposal('pain_stop', `Stop and see a physio — ${label}`, `${e.reasons.join(' ')} These signs need a professional assessment before climbing on it again.`, ['pain', ...e.redFlags],
        { locationKey: e.key, sessionIds: affected, variant: finger ? 'finger_downgrade' : 'rest', protocolId: protocolFor(e.location), seePhysio: true }, null));
    } else if (e.light === 'red') {
      out.push(makeProposal('pain_stop', `Stop aggravating loading — ${label}`, `${e.reasons.join(' ')} Switch to the rehab protocol and re-check in ${r.pain.recheckHours} h.`, ['pain'],
        { locationKey: e.key, sessionIds: affected, variant: finger ? 'finger_downgrade' : 'rest', protocolId: protocolFor(e.location), recheckOn: addDays(asOf, Math.round(r.pain.recheckHours / 24)) }, null));
    } else if (e.light === 'amber') {
      out.push(makeProposal('pain_modify', `Modify training — ${label}`,
        `${e.reasons.join(' ')} Remove the aggravating grip, lower intensity by 15 %, add a rest day, re-check in ${r.pain.recheckHours} h.`, ['pain'],
        { locationKey: e.key, sessionIds: affected, removeGrips: e.aggravatingGrips.length ? e.aggravatingGrips : finger ? RESTRICTED_GRIPS : [], intensityFactor: 0.85, recheckOn: addDays(asOf, Math.round(r.pain.recheckHours / 24)) }, addDays(asOf, 2)));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */

export function proposeModeChange(settings: Settings, today: ISODate): ProposalDraft | null {
  if (settings.mode === 'normal' && settings.newbornSuggestFrom && today >= settings.newbornSuggestFrom) {
    return makeProposal('mode_change', 'Switch to Newborn mode?', 'Your newborn preset date has arrived: 2 short home sessions per week (30-40 min), climbing as an optional bonus, readiness thresholds adjusted for fragmented sleep.', ['calendar'], { mode: 'newborn' }, null);
  }
  return null;
}

/** Leaving newborn/low-capacity goes through a return ramp. */
export function nextModeOnDeactivate(current: TrainingMode): TrainingMode {
  return current === 'newborn' || current === 'low_capacity' ? 'return_ramp' : 'normal';
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

export interface ApplyResult {
  plan: Plan;
  reason: string;
  /** When set, the caller must update settings.mode / sessionsPerWeek and regenerate the plan. */
  settingsPatch?: Partial<Pick<Settings, 'mode' | 'sessionsPerWeek'>>;
  regenerate?: boolean;
}

type ProgressionChange = { type: 'progression'; exerciseId: string; mode: PlannedItem['load']['mode']; value: number; fromDate: ISODate };
type ScaleChange = { type: 'scale_finger_volume'; weekStart: ISODate; factor: number };
type SpwChange = { type: 'sessions_per_week'; value: number };
export type WeeklyChange = ProgressionChange | ScaleChange | SpwChange;

function mapPlanSessions(plan: Plan, f: (s: PlannedSession) => PlannedSession): Plan {
  return { ...plan, updatedAt: nowISO(), weeks: plan.weeks.map((w) => ({ ...w, sessions: w.sessions.map(f) })) };
}

function applyProgression(plan: Plan, c: ProgressionChange): Plan {
  return mapPlanSessions(plan, (s) =>
    s.status !== 'planned' || s.date < c.fromDate
      ? s
      : { ...s, items: s.items.map((i) => (i.exerciseId === c.exerciseId && i.load.mode === c.mode ? { ...i, load: { mode: c.mode, value: c.value }, notes: undefined } : i)) },
  );
}

export function applyProposal(plan: Plan, p: Proposal | ProposalDraft, lib: Library, ctx: LoadContext, r: Rules = defaultRules): ApplyResult {
  const pl = p.payload as Record<string, unknown>;
  switch (p.kind) {
    case 'reschedule': {
      const id = pl.sessionId as string;
      const to = pl.toDate as ISODate;
      return {
        plan: mapPlanSessions(plan, (s) => (s.id === id ? { ...s, date: to, movedFrom: s.movedFrom ?? s.date, status: 'planned' } : s)),
        reason: `Rescheduled missed session to ${to}.`,
      };
    }
    case 'drop': {
      const id = pl.sessionId as string;
      return { plan: mapPlanSessions(plan, (s) => (s.id === id ? { ...s, status: 'dropped' } : s)), reason: 'Dropped missed session (no safe slot).' };
    }
    case 'deload': {
      const ws = pl.weekStart as ISODate;
      const from = (pl.fromDate as ISODate) ?? ws;
      return {
        plan: {
          ...plan,
          updatedAt: nowISO(),
          weeks: plan.weeks.map((w) =>
            w.startDate !== ws ? w : { ...w, isDeload: true, notes: [...(w.notes ?? []), `Early deload: ${p.triggers.join(' ')}`], sessions: w.sessions.map((s) => (s.date >= from ? deloadSession(s, lib, ctx, r) : s)) },
          ),
        },
        reason: `Early deload week of ${ws}: ${p.triggers.join(' ')}`,
      };
    }
    case 'downgrade': {
      const id = pl.sessionId as string;
      const v = pl.variant as DowngradeVariant;
      return { plan: mapPlanSessions(plan, (s) => (s.id === id ? downgradeSession(s, v, lib, ctx) : s)), reason: `Session downgraded (${v}) — ${p.reason}` };
    }
    case 'pain_modify': {
      const ids = new Set(pl.sessionIds as string[]);
      const remove = new Set(pl.removeGrips as string[]);
      const f = (pl.intensityFactor as number) ?? 0.85;
      let next = mapPlanSessions(plan, (s) => {
        if (!ids.has(s.id)) return s;
        const items = s.items.filter((i) => !(i.grip && remove.has(i.grip) && i.role !== 'warmup')).map((i) => scaleItem(i, 1, f, ctx.bodyMassKg));
        return refreshSession({ ...s, items }, lib, ctx);
      });
      // Add rest: drop the next planned high-finger session within 2 days.
      const soon = allSessions(next).filter((s) => ids.has(s.id) && (s.fingerIntensity === 'high' || s.fingerIntensity === 'max')).sort((a, b) => a.date.localeCompare(b.date))[0];
      if (soon) next = mapPlanSessions(next, (s) => (s.id === soon.id ? downgradeSession(s, 'finger_downgrade', lib, ctx) : s));
      return { plan: next, reason: `Pain modification: ${p.reason}` };
    }
    case 'pain_stop': {
      const ids = new Set(pl.sessionIds as string[]);
      const v = (pl.variant as DowngradeVariant) ?? 'finger_downgrade';
      return { plan: mapPlanSessions(plan, (s) => (ids.has(s.id) ? downgradeSession(s, v, lib, ctx) : s)), reason: `Pain stop: ${p.reason}` };
    }
    case 'progression': {
      const c = pl as unknown as ProgressionChange;
      return { plan: applyProgression(plan, { ...c, type: 'progression' }), reason: `Progression: ${p.reason}` };
    }
    case 'weekly_adjustment': {
      let next = plan;
      let patch: ApplyResult['settingsPatch'];
      for (const c of (pl.changes as WeeklyChange[]) ?? []) {
        if (c.type === 'progression') next = applyProgression(next, c);
        else if (c.type === 'scale_finger_volume') {
          next = {
            ...next,
            weeks: next.weeks.map((w) =>
              w.startDate !== c.weekStart ? w : {
                ...w,
                sessions: w.sessions.map((s) => {
                  if (s.status !== 'planned' || s.kind === 'test') return s;
                  const items = s.items.map((i) => (lib.get(i.exerciseId)?.fingerIntensity === 'none' ? i : scaleItem(i, c.factor, 1, ctx.bodyMassKg)));
                  return refreshSession({ ...s, items }, lib, ctx);
                }),
              }),
          };
        } else if (c.type === 'sessions_per_week') patch = { ...(patch ?? {}), sessionsPerWeek: c.value };
      }
      return { plan: { ...next, updatedAt: nowISO() }, reason: `Weekly review: ${p.reason}`, settingsPatch: patch, regenerate: !!patch };
    }
    case 'mode_change': {
      const mode = pl.mode as TrainingMode;
      return { plan, reason: `Mode changed to ${mode}.`, settingsPatch: { mode }, regenerate: true };
    }
    case 'rehab':
    case 'retest':
      return { plan, reason: p.title };
    default:
      return { plan, reason: p.title };
  }
}
