/**
 * VERSIONED MIGRATIONS
 *
 * Migrations are PURE functions on a Snapshot (plain JSON). The same runner is used for:
 *   - upgrading the local IndexedDB (db.ts dumps -> migrates -> rewrites),
 *   - importing old JSON backups,
 *   - merging a Gist snapshot written by an older app version.
 *
 * HOW TO ADD A MIGRATION (example: v1 -> v2)
 *   1. Change types in schema.ts and set SCHEMA_VERSION = 2.
 *   2. Append to MIGRATIONS:
 *        { from: 1, to: 2, description: '...', up: (s) => ({ ...s, stores: { ...s.stores,
 *            climbs: s.stores.climbs.map((c) => ({ ...c, newField: default })) } }) }
 *   3. Add a fixture test in tests/migrations.test.ts (v1 snapshot in -> v2 expectations out).
 *   Never edit a migration that has shipped; add a new one instead.
 */
import { isValidISODate, nowISO } from '../lib/dates';
import { newId } from '../lib/ids';
import { defaultSettings, SETTINGS_ID } from './defaults';
import { SCHEMA_VERSION, STORE_NAMES, type Snapshot, type StoreName } from './schema';

/** Loosely-typed snapshot as it may exist on disk in any past version. */
export interface RawSnapshot {
  app?: string;
  schemaVersion?: number;
  exportedAt?: string;
  deviceId?: string;
  stores?: Record<string, unknown[] | undefined>;
}

export interface Migration {
  from: number;
  to: number;
  description: string;
  up: (s: RawSnapshot) => RawSnapshot;
}

export class MigrationError extends Error {}

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * v0 -> v1: normalise any pre-release / hand-edited / partial data.
 *  - ensure every store exists as an array, drop non-object rows;
 *  - ensure BaseRecord fields (id, createdAt, updatedAt, deleted);
 *  - ensure settings singleton exists and is complete (deep-filled with defaults);
 *  - drop dated rows whose `date` is invalid (they cannot be placed on a timeline);
 *  - checkins/sleep get deterministic ids so two devices converge on one record per day.
 */
function normaliseV0toV1(s: RawSnapshot): RawSnapshot {
  const ts = nowISO();
  const srcStores = isObj(s.stores) ? (s.stores as Record<string, unknown>) : {};
  const stores: Record<string, unknown[]> = {};

  for (const name of STORE_NAMES) {
    const raw = Array.isArray(srcStores[name]) ? (srcStores[name] as unknown[]) : [];
    stores[name] = raw.filter(isObj).map((r) => {
      const rec: Rec = { ...r };
      if (typeof rec.id !== 'string' || !rec.id) rec.id = newId();
      if (typeof rec.createdAt !== 'string') rec.createdAt = (rec.updatedAt as string) ?? ts;
      if (typeof rec.updatedAt !== 'string') rec.updatedAt = rec.createdAt;
      rec.deleted = rec.deleted === true;
      return rec;
    });
  }

  const datedNeedingValidDate: StoreName[] = ['profile', 'benchmarks', 'sessions', 'climbs', 'checkins', 'sleep', 'pain'];
  for (const name of datedNeedingValidDate) {
    stores[name] = stores[name].filter((r) => isValidISODate((r as Rec).date));
  }

  stores.checkins = stores.checkins.map((r) => ({ ...(r as Rec), id: `checkin-${(r as Rec).date}` }));
  stores.sleep = stores.sleep.map((r) => {
    const rec = r as Rec;
    const source = rec.source === 'garmin' ? 'garmin' : 'manual';
    return { ...rec, source, id: `sleep-${rec.date}-${source}` };
  });

  // Settings singleton: deep-fill with defaults so new nested keys always exist.
  const def = defaultSettings() as unknown as Rec;
  const existing = (stores.settings.find((r) => (r as Rec).id === SETTINGS_ID) ?? stores.settings[0]) as Rec | undefined;
  const merged: Rec = { ...def, ...(existing ?? {}), id: SETTINGS_ID };
  for (const key of Object.keys(def)) {
    if (isObj(def[key]) && isObj(merged[key])) merged[key] = { ...(def[key] as Rec), ...(merged[key] as Rec) };
    else if (isObj(def[key])) merged[key] = def[key];
  }
  stores.settings = [merged];

  // Numeric coercion for frequently hand-edited numeric fields.
  stores.sessions = stores.sessions.map((r) => {
    const rec = r as Rec;
    return {
      ...rec,
      durationMin: Number(rec.durationMin) || 0,
      sessionRPE: Math.min(10, Math.max(0, Number(rec.sessionRPE) || 0)),
      sets: Array.isArray(rec.sets) ? rec.sets : [],
      globalLoad: Number(rec.globalLoad) || 0,
      fingerLoad: Number(rec.fingerLoad) || 0,
      restrictedGripLoad: Number(rec.restrictedGripLoad) || 0,
    };
  });

  stores.plans = stores.plans.map((r) => {
    const rec = r as Rec;
    return {
      ...rec,
      macro: Array.isArray(rec.macro) ? rec.macro : [],
      weeks: Array.isArray(rec.weeks) ? rec.weeks : [],
      currentBlockIndex: typeof rec.currentBlockIndex === 'number' ? rec.currentBlockIndex : 0,
    };
  });

  return {
    app: 'climb-coach',
    schemaVersion: 1,
    exportedAt: typeof s.exportedAt === 'string' ? s.exportedAt : ts,
    deviceId: typeof s.deviceId === 'string' ? s.deviceId : 'unknown',
    stores,
  };
}

export const MIGRATIONS: Migration[] = [
  { from: 0, to: 1, description: 'Normalise pre-release/partial data to schema v1', up: normaliseV0toV1 },
];

/**
 * Run migrations from the snapshot's version up to `target`.
 * A snapshot without schemaVersion is treated as v0.
 * Throws if the snapshot is NEWER than this app (user must update the app first).
 */
export function migrateSnapshot(
  input: RawSnapshot,
  migrations: Migration[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): Snapshot {
  if (!isObj(input)) throw new MigrationError('Not a Climb Coach snapshot (not an object).');
  if (input.app !== undefined && input.app !== 'climb-coach') {
    throw new MigrationError(`Not a Climb Coach snapshot (app = ${String(input.app)}).`);
  }
  let v = typeof input.schemaVersion === 'number' ? input.schemaVersion : 0;
  if (v > target) {
    throw new MigrationError(
      `Data was written by a newer app version (schema v${v}, this app supports v${target}). Update the app first.`,
    );
  }
  let s: RawSnapshot = structuredCloneSafe(input);
  while (v < target) {
    const step = migrations.find((m) => m.from === v);
    if (!step) throw new MigrationError(`No migration from schema v${v}.`);
    if (step.to !== v + 1) throw new MigrationError(`Migration ${step.from}->${step.to} must advance by exactly 1.`);
    s = step.up(s);
    s.schemaVersion = step.to;
    v = step.to;
  }
  return s as unknown as Snapshot;
}

/** Validate that the registry is a contiguous chain 0 -> SCHEMA_VERSION (used in tests). */
export function validateMigrationChain(migrations: Migration[] = MIGRATIONS, target: number = SCHEMA_VERSION): void {
  for (let v = 0; v < target; v++) {
    const m = migrations.filter((x) => x.from === v);
    if (m.length !== 1) throw new MigrationError(`Expected exactly one migration from v${v}, found ${m.length}.`);
    if (m[0].to !== v + 1) throw new MigrationError(`Migration from v${v} must target v${v + 1}.`);
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
