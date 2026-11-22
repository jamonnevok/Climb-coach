/**
 * Pure plan edit operations used by the Plan UI (drag & drop, swap, edit, flags, validate)
 * and by the adaptation engine. Every operation returns a NEW plan plus rule violations;
 * the caller records a PlanVersion (date + reason) when the user confirms.
 */
import { nowISO, startOfWeek, todayISO, type ISODate } from '../lib/dates';
import { newId } from '../lib/ids';
import type { ExerciseDef, Plan, PlannedItem, PlannedSession, PlanVersion, PlanWeek } from '../data/schema';
import type { Library } from './library';
import { estimatePlannedSession, type LoadContext } from './load';
import { checkRules, maxIntensity, type RuleViolation } from './planRules';

export interface OpResult {
  plan: Plan;
  violations: RuleViolation[];
}

export function allSessions(plan: Plan): PlannedSession[] {
  return plan.weeks.flatMap((w) => w.sessions);
}

export function findSession(plan: Plan, sessionId: string): { week: PlanWeek; session: PlannedSession } | null {
  for (const week of plan.weeks) {
    const session = week.sessions.find((s) => s.id === sessionId);
    if (session) return { week, session };
  }
  return null;
}

export function weekOf(plan: Plan, date: ISODate): PlanWeek | undefined {
  const ws = startOfWeek(date);
  return plan.weeks.find((w) => w.startDate === ws);
}

function mapSessions(plan: Plan, f: (s: PlannedSession, w: PlanWeek) => PlannedSession | null): Plan {
  return {
    ...plan,
    updatedAt: nowISO(),
    weeks: plan.weeks.map((w) => ({ ...w, sessions: w.sessions.map((s) => f(s, w)).filter((s): s is PlannedSession => !!s) })),
  };
}

/** Recompute derived session fields after item edits. */
export function refreshSession(s: PlannedSession, lib: Library, ctx: LoadContext): PlannedSession {
  const main = s.items.filter((i) => i.role !== 'warmup' && i.role !== 'cooldown');
  const fi = maxIntensity(main.map((i) => lib.get(i.exerciseId)?.fingerIntensity ?? 'none'));
  const next = { ...s, fingerIntensity: fi };
  return { ...next, estFingerLoad: estimatePlannedSession(next, ctx).fingerLoad };
}

export function violationsFor(plan: Plan): RuleViolation[] {
  return checkRules(allSessions(plan), { unavailableDates: plan.weeks.flatMap((w) => w.unavailableDays) });
}

/** Move a session to another date. Sessions moving across weeks are re-homed in the target week. */
export function moveSession(plan: Plan, sessionId: string, toDate: ISODate): OpResult {
  const found = findSession(plan, sessionId);
  if (!found) return { plan, violations: [] };
  const target = weekOf(plan, toDate);
  if (!target) return { plan, violations: [] };
  const moved: PlannedSession = { ...found.session, date: toDate, movedFrom: found.session.movedFrom ?? found.session.date };
  const weeks = plan.weeks.map((w) => {
    let sessions = w.sessions.filter((s) => s.id !== sessionId);
    if (w.id === target.id) sessions = [...sessions, moved].sort((a, b) => a.date.localeCompare(b.date));
    return { ...w, sessions, validated: w.id === target.id || w.id === found.week.id ? false : w.validated };
  });
  const next = { ...plan, weeks, updatedAt: nowISO() };
  return { plan: next, violations: violationsFor(next).filter((v) => v.sessionId === sessionId || v.otherSessionId === sessionId) };
}

export function setSessionStatus(plan: Plan, sessionId: string, status: PlannedSession['status'], logId?: string): Plan {
  return mapSessions(plan, (s) => (s.id === sessionId ? { ...s, status, logId: logId ?? s.logId } : s));
}

export function swapExercise(plan: Plan, sessionId: string, itemId: string, ex: ExerciseDef, lib: Library, ctx: LoadContext): OpResult {
  const next = mapSessions(plan, (s) => {
    if (s.id !== sessionId) return s;
    const items = s.items.map((i): PlannedItem =>
      i.id === itemId
        ? { id: newId(), exerciseId: ex.id, role: i.role, timer: { ...ex.timer }, load: { mode: ex.loadMode, value: null }, grip: ex.defaultGrip, edgeMm: ex.edgeMm, notes: 'Swapped — set the load.' }
        : i,
    );
    return refreshSession({ ...s, items }, lib, ctx);
  });
  return { plan: invalidateWeekOf(next, sessionId), violations: violationsFor(next) };
}

export function updateItem(plan: Plan, sessionId: string, itemId: string, patch: Partial<Omit<PlannedItem, 'id'>>, lib: Library, ctx: LoadContext): OpResult {
  const next = mapSessions(plan, (s) =>
    s.id === sessionId ? refreshSession({ ...s, items: s.items.map((i) => (i.id === itemId ? { ...i, ...patch, timer: { ...i.timer, ...(patch.timer ?? {}) } } : i)) }, lib, ctx) : s,
  );
  return { plan: invalidateWeekOf(next, sessionId), violations: violationsFor(next) };
}

export function addItem(plan: Plan, sessionId: string, ex: ExerciseDef, lib: Library, ctx: LoadContext): OpResult {
  const next = mapSessions(plan, (s) => {
    if (s.id !== sessionId) return s;
    const cdIdx = s.items.findIndex((i) => i.role === 'cooldown');
    const item: PlannedItem = { id: newId(), exerciseId: ex.id, role: 'main', timer: { ...ex.timer }, load: { mode: ex.loadMode, value: null }, grip: ex.defaultGrip, edgeMm: ex.edgeMm };
    const items = [...s.items];
    items.splice(cdIdx >= 0 ? cdIdx : items.length, 0, item);
    return refreshSession({ ...s, items }, lib, ctx);
  });
  return { plan: invalidateWeekOf(next, sessionId), violations: violationsFor(next) };
}

export function removeItem(plan: Plan, sessionId: string, itemId: string, lib: Library, ctx: LoadContext): OpResult {
  const next = mapSessions(plan, (s) => (s.id === sessionId ? refreshSession({ ...s, items: s.items.filter((i) => i.id !== itemId) }, lib, ctx) : s));
  return { plan: invalidateWeekOf(next, sessionId), violations: violationsFor(next) };
}

function invalidateWeekOf(plan: Plan, sessionId: string): Plan {
  return { ...plan, weeks: plan.weeks.map((w) => (w.sessions.some((s) => s.id === sessionId) ? { ...w, validated: false, validatedAt: null } : w)) };
}

/** Toggle an unavailable or outdoor day. The caller should then propose a re-generation of that week. */
export function toggleDayFlag(plan: Plan, date: ISODate, flag: 'unavailable' | 'outdoor', on: boolean): Plan {
  const ws = startOfWeek(date);
  return {
    ...plan,
    updatedAt: nowISO(),
    weeks: plan.weeks.map((w) => {
      if (w.startDate !== ws) return w;
      const key = flag === 'unavailable' ? 'unavailableDays' : 'outdoorDays';
      const set = new Set(w[key]);
      if (on) set.add(date);
      else set.delete(date);
      return { ...w, [key]: [...set].sort(), validated: false, validatedAt: null };
    }),
  };
}

export function validateWeek(plan: Plan, weekId: string): Plan {
  const ts = nowISO();
  return {
    ...plan,
    status: 'active',
    updatedAt: ts,
    weeks: plan.weeks.map((w) => (w.id === weekId ? { ...w, validated: true, validatedAt: ts } : w)),
  };
}

export function validateAll(plan: Plan): Plan {
  const ts = nowISO();
  return { ...plan, status: 'active', updatedAt: ts, weeks: plan.weeks.map((w) => ({ ...w, validated: true, validatedAt: ts })) };
}

/** Snapshot the plan with a reason; bumps plan.version. Persist both returned records. */
export function recordVersion(plan: Plan, reason: string, actor: PlanVersion['actor'], proposalId?: string, date: ISODate = todayISO()): { plan: Plan; version: PlanVersion } {
  const ts = nowISO();
  const bumped: Plan = { ...plan, version: plan.version + 1, updatedAt: ts };
  return {
    plan: bumped,
    version: {
      id: newId(),
      createdAt: ts,
      updatedAt: ts,
      planId: plan.id,
      version: bumped.version,
      date,
      reason,
      actor,
      proposalId,
      snapshot: JSON.parse(JSON.stringify(bumped)) as Plan,
    },
  };
}
