/**
 * DERIVED STATE — pure function from the in-memory data snapshot to everything the UI shows.
 * No I/O; recomputed after each mutation (data is small: one user).
 */
import { defaultSettings, initialProfile } from '../data/defaults';
import type { Plan, PlannedSession, ProfileEntry, Proposal, Settings, Snapshot } from '../data/schema';
import { addDays, startOfWeek, type ISODate } from '../lib/dates';
import { rankWeaknesses, type WeaknessRanking } from '../engine/assessment';
import { calibrationStatus, type CalibrationStatus } from '../engine/coldStart';
import { buildLibrary, buildLoadContext, type Library } from '../engine/library';
import {
  computeACWR,
  fingerCapsForWeek,
  plannedToDatedLoads,
  projectACWR,
  toDatedLoads,
  weekOnWeek,
  type AcwrResult,
  type DatedLoad,
  type FingerCaps,
  type LoadContext,
  type Projection,
  type WeekOnWeek,
} from '../engine/load';
import { evaluatePain, recentFingerPainMax, type PainEvaluation } from '../engine/pain';
import { readinessSeries, sleepBaseline, type ReadinessResult } from '../engine/readiness';
import { asymmetryWatch, type AsymmetryWatch } from '../tindeq/forceAnalysis';
import { allSessions } from '../engine/planOps';

export type AppData = Snapshot['stores'];

export interface Derived {
  today: ISODate;
  profile: ProfileEntry;
  settings: Settings;
  lib: Library;
  ctx: LoadContext;
  loads: DatedLoad[];
  global: AcwrResult;
  finger: AcwrResult;
  restricted: AcwrResult;
  wow: WeekOnWeek;
  caps: FingerCaps;
  calibration: CalibrationStatus;
  sleepBaselineH: number;
  readinessToday: ReadinessResult;
  readiness: ReadinessResult[];
  painEvals: PainEvaluation[];
  fingerPainRecent: number;
  plan: Plan | undefined;
  todaySessions: PlannedSession[];
  nextSession: PlannedSession | undefined;
  projection: Projection | null;
  ranking: WeaknessRanking;
  asymmetry: AsymmetryWatch;
  pending: Proposal[];
  checkedInToday: boolean;
  isReviewDay: boolean;
  reviewWeekStart: ISODate;
  reviewDone: boolean;
}

export function latestProfile(data: AppData): ProfileEntry {
  const all = data.profile.filter((p) => !p.deleted);
  if (!all.length) return initialProfile();
  return [...all].sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt))[all.length - 1];
}

export function currentSettings(data: AppData): Settings {
  return data.settings.find((s) => s.id === 'settings') ?? defaultSettings();
}

export function currentPlan(data: AppData): Plan | undefined {
  return data.plans
    .filter((p) => !p.deleted && p.status !== 'archived')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .pop();
}

export function derive(data: AppData, today: ISODate): Derived {
  const profile = latestProfile(data);
  const settings = currentSettings(data);
  const lib = buildLibrary(data.customExercises);
  const benchmarks = data.benchmarks.filter((b) => !b.deleted);
  const ctx = buildLoadContext(profile, benchmarks, lib);
  const loads = toDatedLoads(data.sessions);
  const cs = settings.coldStart;
  const global = computeACWR(loads, { metric: 'global', asOf: today, coldStart: cs });
  const finger = computeACWR(loads, { metric: 'finger', asOf: today, coldStart: cs });
  const restricted = computeACWR(loads, { metric: 'restricted', asOf: today, coldStart: cs });
  const wow = weekOnWeek(loads, today, cs);
  const caps = fingerCapsForWeek(loads, today, cs);
  const checkins = data.checkins.filter((c) => !c.deleted);
  const sleep = data.sleep.filter((s) => !s.deleted);
  const readiness = readinessSeries(checkins, sleep, settings, today, 28);
  const plan = currentPlan(data);
  const sessions = plan ? allSessions(plan) : [];
  const todaySessions = sessions.filter((s) => s.date === today && s.status !== 'dropped');
  const nextSession = sessions
    .filter((s) => s.date >= today && s.status === 'planned' && s.kind !== 'prehab')
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  let projection: Projection | null = null;
  if (plan) {
    const loggedToday = loads.some((l) => l.date === today);
    const asOf = loggedToday ? today : addDays(today, -1);
    const until = addDays(startOfWeek(today), 13);
    const planned = plannedToDatedLoads(sessions.filter((s) => s.date > asOf && s.date <= until), ctx);
    projection = projectACWR(loads, planned, asOf, until, cs);
  }
  const reviewWeekStart = startOfWeek(today);
  const pain = data.pain.filter((p) => !p.deleted);
  return {
    today,
    profile,
    settings,
    lib,
    ctx,
    loads,
    global,
    finger,
    restricted,
    wow,
    caps,
    calibration: calibrationStatus(loads, cs, today),
    sleepBaselineH: sleepBaseline(sleep, settings, today),
    readinessToday: readiness[readiness.length - 1],
    readiness,
    painEvals: evaluatePain(pain, today),
    fingerPainRecent: recentFingerPainMax(pain, today),
    plan,
    todaySessions,
    nextSession,
    projection,
    ranking: rankWeaknesses(profile, benchmarks, latestQuestionnaire(data), data.climbs.filter((c) => !c.deleted), today),
    asymmetry: asymmetryWatch(benchmarks, today),
    pending: data.proposals.filter((p) => !p.deleted && p.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    checkedInToday: checkins.some((c) => c.date === today),
    isReviewDay: new Date(today + 'T12:00:00').getDay() === 0,
    reviewWeekStart,
    reviewDone: data.weeklyReviews.some((w) => !w.deleted && w.weekStart === reviewWeekStart && w.completedAt !== null),
  };
}

export function latestQuestionnaire(data: AppData) {
  return data.questionnaires.filter((q) => !q.deleted).sort((a, b) => a.date.localeCompare(b.date)).pop();
}

/** Projected finger/global ACWR if a given planned session is done on its date. */
export function projectSession(d: Derived, session: PlannedSession): Projection {
  const asOf = addDays(session.date, -1);
  return projectACWR(d.loads, plannedToDatedLoads([{ ...session, status: 'planned' }], d.ctx), asOf, session.date, d.settings.coldStart);
}
