/**
 * GARMIN IMPORT (app side).
 * The GitHub Action (scripts/garmin-sync.mjs) calls the Garmin Connect Personal API with your
 * personal key and stores the RAW JSON responses in the private gist (garmin-raw.json).
 * Parsing happens here, in tested TypeScript, so it can be fixed without touching the Action.
 *
 * The Personal API response shapes are not fully documented. The parser is defensive: it walks
 * the JSON, collects every object that has a `calendarDate`, and reads known field names:
 *   sleep:  sleepTimeSeconds, sleepScores.overall.value (or overallSleepScore / sleepScore)
 *   HRV:    lastNightAvg (HRV summary)
 *   daily:  restingHeartRate, bodyBatteryHighestValue
 * Missing values stay missing (never zero). Garmin nights become SleepRecords with
 * id `sleep-<date>-garmin` (source 'garmin'), preferred over manual entries by readiness.
 */
import type { Repo } from '../data/repo';
import type { SleepRecord } from '../data/schema';
import { isValidISODate } from '../lib/dates';

export interface GarminRaw {
  version: number;
  fetchedAt: string;
  from: string;
  to: string;
  sleep?: unknown;
  hrv?: unknown;
  daily?: unknown;
  errors?: Record<string, string>;
}

export interface GarminDay {
  date: string;
  sleepH?: number;
  sleepScore?: number;
  hrvMs?: number;
  restingHr?: number;
  bodyBatteryHigh?: number;
}

export interface GarminImportResult {
  fetchedAt: string | null;
  days: number;
  saved: number;
  errors: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** All objects (at any depth) carrying a calendarDate. */
export function collectDated(json: unknown, out: Obj[] = []): Obj[] {
  if (Array.isArray(json)) {
    for (const x of json) collectDated(x, out);
  } else if (isObj(json)) {
    if (typeof json.calendarDate === 'string' && isValidISODate(json.calendarDate.slice(0, 10))) out.push(json);
    for (const v of Object.values(json)) if (typeof v === 'object' && v !== null) collectDated(v, out);
  }
  return out;
}

function sleepScoreOf(o: Obj): number | undefined {
  const scores = o.sleepScores;
  if (isObj(scores)) {
    const overall = scores.overall;
    if (isObj(overall)) return num(overall.value);
    return num(scores.overallScore);
  }
  return num(o.overallSleepScore) ?? num(o.sleepScore);
}

export function parseGarmin(raw: GarminRaw): GarminDay[] {
  const days = new Map<string, GarminDay>();
  const day = (d: string) => days.get(d) ?? days.set(d, { date: d }).get(d)!;
  for (const o of collectDated(raw.sleep)) {
    const secs = num(o.sleepTimeSeconds);
    if (secs === undefined) continue;
    const d = day((o.calendarDate as string).slice(0, 10));
    d.sleepH = Math.round((secs / 3600) * 100) / 100;
    const sc = sleepScoreOf(o);
    if (sc !== undefined) d.sleepScore = sc;
  }
  for (const o of collectDated(raw.hrv)) {
    const v = num(o.lastNightAvg);
    if (v !== undefined) day((o.calendarDate as string).slice(0, 10)).hrvMs = v;
  }
  for (const o of collectDated(raw.daily)) {
    const d = (o.calendarDate as string).slice(0, 10);
    const rhr = num(o.restingHeartRate);
    const bb = num(o.bodyBatteryHighestValue);
    if (rhr !== undefined) day(d).restingHr = rhr;
    if (bb !== undefined) day(d).bodyBatteryHigh = bb;
  }
  return [...days.values()].filter((d) => d.sleepH !== undefined || d.hrvMs !== undefined || d.restingHr !== undefined).sort((a, b) => a.date.localeCompare(b.date));
}

/** Upsert Garmin nights; only writes records whose values changed (keeps sync quiet). */
export async function importGarmin(repo: Repo, text: string): Promise<GarminImportResult> {
  let raw: GarminRaw;
  try {
    raw = JSON.parse(text) as GarminRaw;
  } catch {
    return { fetchedAt: null, days: 0, saved: 0, errors: ['garmin-raw.json is not valid JSON'] };
  }
  const parsed = parseGarmin(raw);
  const existing = new Map((await repo.list('sleep', { includeDeleted: true })).map((s) => [s.id, s]));
  let saved = 0;
  for (const g of parsed) {
    if (g.sleepH === undefined) continue; // a night without duration is not a sleep record
    const id = `sleep-${g.date}-garmin`;
    const cur = existing.get(id);
    const next: Omit<SleepRecord, 'createdAt' | 'updatedAt'> = {
      id,
      date: g.date,
      durationH: g.sleepH,
      sleepScore: g.sleepScore,
      restingHr: g.restingHr,
      hrvMs: g.hrvMs,
      bodyBatteryHigh: g.bodyBatteryHigh,
      source: 'garmin',
      deleted: false,
    };
    const same =
      cur &&
      !cur.deleted &&
      cur.durationH === next.durationH &&
      cur.sleepScore === next.sleepScore &&
      cur.restingHr === next.restingHr &&
      cur.hrvMs === next.hrvMs &&
      cur.bodyBatteryHigh === next.bodyBatteryHigh;
    if (same) continue;
    await repo.save('sleep', { ...next, createdAt: cur?.createdAt });
    saved++;
  }
  return { fetchedAt: raw.fetchedAt ?? null, days: parsed.length, saved, errors: Object.entries(raw.errors ?? {}).map(([k, v]) => `${k}: ${v}`) };
}
