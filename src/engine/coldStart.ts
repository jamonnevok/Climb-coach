/**
 * COLD START
 * No historical import: onboarding asks for a typical week over the last 4 weeks.
 * That week seeds both EWMAs (acute & chronic), so the very first sessions are compared
 * with a realistic baseline instead of zero (which would produce absurd ratios).
 * ACWR is labelled "calibrating" until `calibrationDays` (28) of logs exist; meanwhile
 * the safety net is week-on-week change limits + absolute finger caps (load.ts).
 */
import { thresholds as defaultThresholds, type Thresholds } from '../config';
import { diffDays, type ISODate } from '../lib/dates';
import type { ColdStartSeed } from '../data/schema';
import { coldStartDailySeed, type DatedLoad } from './load';

export interface ColdStartInput {
  sessionsPerWeek: number;
  avgDurationMin: number;
  avgSessionRPE: number;
  fingerSessionsPerWeek: number;
  fingerMinutesPerSession: number;
  fingerIntensity: ColdStartSeed['fingerIntensity'];
}

export interface ValidationIssue {
  field: keyof ColdStartInput;
  message: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function validateColdStart(input: ColdStartInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!(input.sessionsPerWeek >= 0 && input.sessionsPerWeek <= 14)) issues.push({ field: 'sessionsPerWeek', message: 'Between 0 and 14 sessions per week.' });
  if (!(input.avgDurationMin >= 0 && input.avgDurationMin <= 600)) issues.push({ field: 'avgDurationMin', message: 'Between 0 and 600 minutes.' });
  if (!(input.avgSessionRPE >= 0 && input.avgSessionRPE <= 10)) issues.push({ field: 'avgSessionRPE', message: 'Session RPE is 0-10.' });
  if (!(input.fingerSessionsPerWeek >= 0 && input.fingerSessionsPerWeek <= input.sessionsPerWeek + 7)) {
    issues.push({ field: 'fingerSessionsPerWeek', message: 'Finger sessions must be a realistic number (0-14).' });
  }
  if (!(input.fingerMinutesPerSession >= 0 && input.fingerMinutesPerSession <= 120)) {
    issues.push({ field: 'fingerMinutesPerSession', message: 'Minutes actually on holds/hangboard per session, 0-120.' });
  }
  return issues;
}

export function buildColdStartSeed(input: ColdStartInput, seededAt: ISODate): ColdStartSeed {
  return {
    sessionsPerWeek: clamp(input.sessionsPerWeek, 0, 14),
    avgDurationMin: clamp(input.avgDurationMin, 0, 600),
    avgSessionRPE: clamp(input.avgSessionRPE, 0, 10),
    fingerSessionsPerWeek: clamp(input.fingerSessionsPerWeek, 0, 14),
    fingerMinutesPerSession: clamp(input.fingerMinutesPerSession, 0, 120),
    fingerIntensity: input.fingerIntensity,
    seededAt,
  };
}

/** Pre-filled suggestion for the owner's profile (3 sessions x 90 min, moderate-hard). */
export const SUGGESTED_COLD_START: ColdStartInput = {
  sessionsPerWeek: 3,
  avgDurationMin: 90,
  avgSessionRPE: 7,
  fingerSessionsPerWeek: 3,
  fingerMinutesPerSession: 12,
  fingerIntensity: 'high',
};

export interface CalibrationStatus {
  calibrating: boolean;
  daysOfData: number;
  daysRemaining: number;
  progressPct: number;
  label: string;
  seededWeekly: { global: number; finger: number };
}

export function calibrationStatus(
  loads: DatedLoad[],
  coldStart: ColdStartSeed | null,
  asOf: ISODate,
  config: Thresholds = defaultThresholds,
): CalibrationStatus {
  const firstLog = loads.reduce<ISODate | null>((m, l) => (m === null || l.date < m ? l.date : m), null);
  const starts = [coldStart?.seededAt, firstLog].filter((d): d is ISODate => !!d && d <= asOf).sort();
  const days = starts.length ? diffDays(starts[0], asOf) + 1 : 0;
  const total = config.acwr.calibrationDays;
  const calibrating = days < total;
  return {
    calibrating,
    daysOfData: days,
    daysRemaining: Math.max(0, total - days),
    progressPct: Math.min(100, Math.round((days / total) * 100)),
    label: calibrating ? config.coldStart.calibratingLabel : 'Calibrated',
    seededWeekly: {
      global: Math.round(coldStartDailySeed(coldStart, 'global', { config }) * 7),
      finger: Math.round(coldStartDailySeed(coldStart, 'finger', { config }) * 7 * 10) / 10,
    },
  };
}
