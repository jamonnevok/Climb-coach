/**
 * GUIDED SESSION — walks through a PlannedSession exercise by exercise and collects SetLogs.
 * Pure state (no DOM). The UI owns one TimerState per current item (timerEngine.ts) and calls
 * recordSet() after each `set_complete` event with the quick input (completed, load, RPE, feeling).
 * finish() returns a SessionLog draft; loads are computed by engine/load.ts at save time.
 */
import { nowISO, todayISO, type ISODate } from '../lib/dates';
import { newId } from '../lib/ids';
import type { Hand, PlannedItem, PlannedSession, Scale5, SessionLog, SetLog } from '../data/schema';

export interface QuickSetInput {
  completed: boolean;
  /** Reps / cycles actually done (defaults to planned reps when completed). */
  reps?: number;
  loadValue?: number | null;
  rpe?: number;
  fingerFeeling?: Scale5;
  hand?: Hand;
  peakForceKg?: number;
  forceCurveId?: string;
  endedByForceDrop?: boolean;
}

export interface GuidedState {
  session: PlannedSession;
  items: PlannedItem[];
  itemIndex: number;
  sets: SetLog[];
  skippedItems: string[];
  startedAt: string;
  /** Per-item override of the number of sets (add/remove set on the fly). */
  setCounts: Record<string, number>;
}

export function startGuided(session: PlannedSession, now: Date = new Date()): GuidedState {
  return {
    session,
    items: session.items,
    itemIndex: 0,
    sets: [],
    skippedItems: [],
    startedAt: nowISO(now),
    setCounts: Object.fromEntries(session.items.map((i) => [i.id, i.timer.sets])),
  };
}

export function currentItem(g: GuidedState): PlannedItem | undefined {
  return g.items[g.itemIndex];
}

export function setsForItem(g: GuidedState, itemId: string): SetLog[] {
  const item = g.items.find((i) => i.id === itemId);
  return item ? g.sets.filter((s) => s.itemId === itemId) : [];
}

export function recordSet(g: GuidedState, input: QuickSetInput, now: Date = new Date()): GuidedState {
  const item = currentItem(g);
  if (!item) return g;
  const done = setsForItem(g, item.id).length;
  const reps = input.reps ?? (input.completed ? item.timer.reps : 0);
  const log: SetLog = {
    id: newId(),
    itemId: item.id,
    exerciseId: item.exerciseId,
    setIndex: done,
    completed: input.completed,
    reps,
    workS: item.timer.workS || (item.timer.totalS ?? 0),
    load: { mode: item.load.mode, value: input.loadValue !== undefined ? input.loadValue : item.load.value },
    grip: item.grip,
    edgeMm: item.edgeMm,
    hand: input.hand,
    rpe: input.rpe,
    fingerFeeling: input.fingerFeeling,
    peakForceKg: input.peakForceKg,
    forceCurveId: input.forceCurveId,
    endedByForceDrop: input.endedByForceDrop,
    at: nowISO(now),
  };
  return { ...g, sets: [...g.sets, log] };
}

export function changeSetCount(g: GuidedState, delta: 1 | -1): GuidedState {
  const item = currentItem(g);
  if (!item) return g;
  const done = setsForItem(g, item.id).length;
  const cur = g.setCounts[item.id] ?? item.timer.sets;
  const next = Math.max(Math.max(1, done), cur + delta);
  return { ...g, setCounts: { ...g.setCounts, [item.id]: next } };
}

export function itemComplete(g: GuidedState): boolean {
  const item = currentItem(g);
  if (!item) return true;
  return setsForItem(g, item.id).length >= (g.setCounts[item.id] ?? item.timer.sets);
}

export function next(g: GuidedState): GuidedState {
  return { ...g, itemIndex: Math.min(g.items.length, g.itemIndex + 1) };
}

export function previous(g: GuidedState): GuidedState {
  return { ...g, itemIndex: Math.max(0, g.itemIndex - 1) };
}

export function skipItem(g: GuidedState): GuidedState {
  const item = currentItem(g);
  return item ? { ...next(g), skippedItems: [...g.skippedItems, item.id] } : g;
}

export function isFinished(g: GuidedState): boolean {
  return g.itemIndex >= g.items.length;
}

/** Elapsed minutes since start (rounded). */
export function elapsedMin(g: GuidedState, now: Date = new Date()): number {
  return Math.max(1, Math.round((now.getTime() - Date.parse(g.startedAt)) / 60000));
}

/** Build the SessionLog draft. sessionRPE and duration are asked on the finish screen. */
export function finish(
  g: GuidedState,
  input: { sessionRPE: number; durationMin?: number; notes?: string; date?: ISODate },
  now: Date = new Date(),
): Omit<SessionLog, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    date: input.date ?? todayISO(now),
    startedAt: g.startedAt,
    kind: g.session.kind,
    plannedSessionId: g.session.id,
    durationMin: input.durationMin ?? elapsedMin(g, now),
    sessionRPE: input.sessionRPE,
    location: g.session.location,
    sets: g.sets,
    globalLoad: 0,
    fingerLoad: 0,
    restrictedGripLoad: 0,
    source: 'guided',
    notes: [input.notes, g.skippedItems.length ? `Skipped ${g.skippedItems.length} item(s).` : ''].filter(Boolean).join(' ') || undefined,
  };
}
