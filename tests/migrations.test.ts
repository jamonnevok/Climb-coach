import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  MigrationError,
  migrateSnapshot,
  validateMigrationChain,
  type Migration,
  type RawSnapshot,
} from '../src/data/migrations';
import { SCHEMA_VERSION, STORE_NAMES } from '../src/data/schema';
import { SETTINGS_ID } from '../src/data/defaults';

describe('migration registry', () => {
  it('is a contiguous chain from v0 to SCHEMA_VERSION', () => {
    expect(() => validateMigrationChain(MIGRATIONS, SCHEMA_VERSION)).not.toThrow();
  });
});

describe('v0 -> v1 normalisation', () => {
  const v0: RawSnapshot = {
    stores: {
      sessions: [
        { date: '2026-11-02', kind: 'training', durationMin: '90', sessionRPE: 14 },
        { date: 'not-a-date', kind: 'training', durationMin: 60, sessionRPE: 7 },
        'garbage' as unknown as object,
      ],
      checkins: [{ date: '2026-11-03', sleepQuality: 4, fatigue: 3, soreness: 4, stress: 3, motivation: 5, fingerStatus: 4 }],
      sleep: [{ date: '2026-11-03', durationH: 7.2, source: 'garmin' }],
      settings: [{ id: SETTINGS_ID, sessionsPerWeek: 4, tindeq: { deviceName: 'Progressor_123' } }],
    },
  };

  const out = migrateSnapshot(v0);

  it('stamps version and app', () => {
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.app).toBe('climb-coach');
  });

  it('creates every store', () => {
    for (const s of STORE_NAMES) expect(Array.isArray(out.stores[s])).toBe(true);
  });

  it('drops rows with invalid dates and non-objects; coerces numbers; clamps RPE', () => {
    expect(out.stores.sessions).toHaveLength(1);
    const s = out.stores.sessions[0];
    expect(s.durationMin).toBe(90);
    expect(s.sessionRPE).toBe(10);
    expect(s.sets).toEqual([]);
    expect(typeof s.id).toBe('string');
    expect(s.deleted).toBe(false);
    expect(typeof s.updatedAt).toBe('string');
  });

  it('gives checkins/sleep deterministic per-day ids', () => {
    expect(out.stores.checkins[0].id).toBe('checkin-2026-11-03');
    expect(out.stores.sleep[0].id).toBe('sleep-2026-11-03-garmin');
  });

  it('deep-fills settings while keeping user values', () => {
    const st = out.stores.settings[0];
    expect(st.id).toBe(SETTINGS_ID);
    expect(st.sessionsPerWeek).toBe(4);
    expect(st.tindeq.deviceName).toBe('Progressor_123');
    expect(st.tindeq.deviceId).toBeNull();
    expect(st.sync.autoSync).toBe(true);
    expect(st.theme).toBe('dark');
  });

  it('does not mutate its input', () => {
    expect((v0.stores!.sessions as unknown[]).length).toBe(3);
  });

  it('is idempotent for an already-current snapshot', () => {
    const again = migrateSnapshot(out as unknown as RawSnapshot);
    expect(again).toEqual(out);
  });
});

describe('runner', () => {
  it('rejects snapshots from a newer app', () => {
    expect(() => migrateSnapshot({ app: 'climb-coach', schemaVersion: SCHEMA_VERSION + 1, stores: {} })).toThrow(MigrationError);
  });

  it('rejects foreign files', () => {
    expect(() => migrateSnapshot({ app: 'other-app', schemaVersion: 1, stores: {} })).toThrow(MigrationError);
  });

  it('chains future migrations in order (simulated v1 -> v2 -> v3)', () => {
    const chain: Migration[] = [
      ...MIGRATIONS,
      {
        from: 1,
        to: 2,
        description: 'rename attempts -> tries',
        up: (s) => ({
          ...s,
          stores: { ...s.stores, climbs: (s.stores!.climbs ?? []).map((c) => ({ ...(c as object), tries: (c as { attempts: number }).attempts })) },
        }),
      },
      {
        from: 2,
        to: 3,
        description: 'add rock default',
        up: (s) => ({
          ...s,
          stores: { ...s.stores, climbs: (s.stores!.climbs ?? []).map((c) => ({ rock: 'limestone', ...(c as object) })) },
        }),
      },
    ];
    const v1: RawSnapshot = {
      app: 'climb-coach',
      schemaVersion: 1,
      stores: { climbs: [{ id: 'c1', createdAt: 'x', updatedAt: 'x', date: '2026-11-01', attempts: 4 }] },
    };
    const out = migrateSnapshot(v1, chain, 3) as unknown as { schemaVersion: number; stores: { climbs: Record<string, unknown>[] } };
    expect(out.schemaVersion).toBe(3);
    expect(out.stores.climbs[0].tries).toBe(4);
    expect(out.stores.climbs[0].rock).toBe('limestone');
  });

  it('fails loudly on a gap in the chain', () => {
    const broken: Migration[] = [...MIGRATIONS, { from: 2, to: 3, description: 'gap', up: (s) => s }];
    expect(() => migrateSnapshot({ app: 'climb-coach', schemaVersion: 1, stores: {} }, broken, 3)).toThrow(/No migration from schema v1/);
  });
});
