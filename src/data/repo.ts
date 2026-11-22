/**
 * Repository: the ONLY way UI/engines write persisted data.
 * Guarantees timestamps, tombstones, singleton settings and dated-history helpers.
 */
import { nowISO, todayISO } from '../lib/dates';
import { newId } from '../lib/ids';
import { defaultSettings, emptySnapshot, initialProfile, SETTINGS_ID } from './defaults';
import { mergeSnapshots, purgeTombstones, type MergeStats } from './merge';
import { migrateSnapshot, type RawSnapshot } from './migrations';
import {
  SCHEMA_VERSION,
  STORE_NAMES,
  type BaseRecord,
  type BenchmarkResult,
  type BenchmarkType,
  type ProfileEntry,
  type Settings,
  type Snapshot,
  type StoreMap,
  type StoreName,
} from './schema';
import type { StorageBackend } from './storage';

/** Input for create: BaseRecord fields optional. */
export type Draft<T extends BaseRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & Partial<BaseRecord>;

export class Repo {
  constructor(private storage: StorageBackend, private clock: () => Date = () => new Date()) {}

  private now() {
    return nowISO(this.clock());
  }

  /** Create or update; always bumps updatedAt (drives last-write-wins sync). */
  async save<K extends StoreName>(store: K, draft: Draft<StoreMap[K]> | StoreMap[K]): Promise<StoreMap[K]> {
    const ts = this.now();
    const rec = {
      ...draft,
      id: draft.id ?? newId(),
      createdAt: draft.createdAt ?? ts,
      updatedAt: ts,
      deleted: draft.deleted ?? false,
    } as StoreMap[K];
    await this.storage.put(store, rec);
    return rec;
  }

  async saveMany<K extends StoreName>(store: K, drafts: (Draft<StoreMap[K]> | StoreMap[K])[]): Promise<StoreMap[K][]> {
    const ts = this.now();
    const recs = drafts.map(
      (d) => ({ ...d, id: d.id ?? newId(), createdAt: d.createdAt ?? ts, updatedAt: ts, deleted: d.deleted ?? false }) as StoreMap[K],
    );
    await this.storage.putMany(store, recs);
    return recs;
  }

  async get<K extends StoreName>(store: K, id: string): Promise<StoreMap[K] | undefined> {
    const r = await this.storage.get(store, id);
    return r && !(r as BaseRecord).deleted ? r : undefined;
  }

  async list<K extends StoreName>(store: K, opts: { includeDeleted?: boolean } = {}): Promise<StoreMap[K][]> {
    const all = await this.storage.getAll(store);
    return opts.includeDeleted ? all : all.filter((r) => !(r as BaseRecord).deleted);
  }

  /** Records with a `date` field in [from, to] inclusive, sorted ascending. */
  async listByDate<K extends StoreName>(store: K, from: string, to: string): Promise<StoreMap[K][]> {
    const all = await this.list(store);
    return all
      .filter((r) => {
        const d = (r as unknown as { date?: string }).date;
        return typeof d === 'string' && d >= from && d <= to;
      })
      .sort((a, b) => String((a as unknown as { date: string }).date).localeCompare((b as unknown as { date: string }).date));
  }

  async softDelete(store: StoreName, id: string): Promise<void> {
    const r = await this.storage.get(store, id);
    if (!r) return;
    await this.storage.put(store, { ...(r as BaseRecord), deleted: true, updatedAt: this.now() } as never);
  }

  /* ---------------- settings & profile ---------------- */

  async getSettings(): Promise<Settings> {
    const s = await this.storage.get('settings', SETTINGS_ID);
    if (s) return s;
    const def = defaultSettings(this.clock());
    await this.storage.put('settings', def);
    return def;
  }

  async updateSettings(patch: Partial<Omit<Settings, keyof BaseRecord>>): Promise<Settings> {
    const cur = await this.getSettings();
    return this.save('settings', { ...cur, ...patch });
  }

  /** Latest profile by date (then updatedAt). Creates the initial profile if none. */
  async getProfile(): Promise<ProfileEntry> {
    const all = await this.list('profile');
    if (all.length === 0) return this.save('profile', initialProfile(todayISO(this.clock()), this.clock()));
    return all.sort((a, b) => (a.date === b.date ? a.updatedAt.localeCompare(b.updatedAt) : a.date.localeCompare(b.date)))[all.length - 1];
  }

  /** Editing the profile appends a dated entry (or updates today's entry). History is preserved. */
  async updateProfile(patch: Partial<Omit<ProfileEntry, keyof BaseRecord | 'date'>>, date = todayISO(this.clock())): Promise<ProfileEntry> {
    const cur = await this.getProfile();
    const base = { ...cur, ...patch, date };
    if (cur.date === date) return this.save('profile', base);
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = base;
    void _id; void _c; void _u;
    return this.save('profile', rest);
  }

  async profileHistory(): Promise<ProfileEntry[]> {
    return (await this.list('profile')).sort((a, b) => a.date.localeCompare(b.date));
  }

  /* ---------------- benchmarks ---------------- */

  async benchmarkHistory(type: BenchmarkType, hand?: BenchmarkResult['hand']): Promise<BenchmarkResult[]> {
    return (await this.list('benchmarks'))
      .filter((b) => b.type === type && (hand === undefined || b.hand === hand))
      .sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
  }

  async latestBenchmark(type: BenchmarkType, hand?: BenchmarkResult['hand']): Promise<BenchmarkResult | undefined> {
    const h = await this.benchmarkHistory(type, hand);
    return h[h.length - 1];
  }

  /* ---------------- snapshot: export / import / sync ---------------- */

  async exportSnapshot(): Promise<Snapshot> {
    const deviceId = (await this.storage.getMeta<string>('deviceId')) ?? 'unknown';
    const snap = emptySnapshot(deviceId, this.clock());
    for (const name of STORE_NAMES) {
      (snap.stores as Record<string, unknown[]>)[name] = await this.storage.getAll(name);
    }
    snap.schemaVersion = SCHEMA_VERSION;
    return snap;
  }

  /**
   * Import a snapshot from any past schema version.
   *  - 'merge': last-write-wins per record (safe default, used by sync).
   *  - 'replace': wipe local stores and load the snapshot (a pre-import backup is kept in meta).
   */
  async importSnapshot(raw: RawSnapshot, mode: 'merge' | 'replace' = 'merge'): Promise<MergeStats> {
    const incoming = migrateSnapshot(raw);
    const local = await this.exportSnapshot();
    await this.storage.setMeta('preImportBackup', local);
    let target: Snapshot;
    let stats: MergeStats;
    if (mode === 'replace') {
      target = incoming;
      const count = STORE_NAMES.reduce((n, s) => n + (incoming.stores[s]?.length ?? 0), 0);
      stats = { added: count, updated: 0, unchanged: 0, perStore: {} };
    } else {
      const res = mergeSnapshots(local, incoming);
      target = res.merged;
      stats = res.stats;
    }
    target = purgeTombstones(target, 180, todayISO(this.clock()));
    for (const name of STORE_NAMES) {
      await this.storage.clear(name);
      await this.storage.putMany(name, target.stores[name] as never[]);
    }
    return stats;
  }
}
