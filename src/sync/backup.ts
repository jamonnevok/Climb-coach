/**
 * AUTOMATIC WEEKLY BACKUP
 *  - every 7 days (checked when the app opens / comes to the foreground) a full JSON snapshot
 *    is stored on this device in a separate IndexedDB database (last 8 kept);
 *  - optional: also download the file (Android Chrome saves it to Downloads);
 *  - when Gist sync is on, every sync is also a Gist revision (free remote history).
 * Restoring a backup = Import 'replace' (a pre-import copy is kept by Repo).
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { Repo } from '../data/repo';
import { nowISO, todayISO } from '../lib/dates';
import { getDeviceState, setDeviceState } from './deviceState';

export interface BackupMeta {
  id: string; // ISO timestamp
  date: string;
  bytes: number;
  records: number;
  auto: boolean;
}

export interface BackupStore {
  list(): Promise<BackupMeta[]>;
  put(meta: BackupMeta, json: string): Promise<void>;
  get(id: string): Promise<string | undefined>;
  remove(id: string): Promise<void>;
}

export const KEEP_BACKUPS = 8;
export const BACKUP_INTERVAL_DAYS = 7;

/** IndexedDB implementation (separate DB so it never interferes with app migrations). */
export class IdbBackupStore implements BackupStore {
  private db: Promise<IDBPDatabase>;
  constructor() {
    this.db = openDB('climb-coach-backups', 1, {
      upgrade(db) {
        db.createObjectStore('meta', { keyPath: 'id' });
        db.createObjectStore('data');
      },
    });
  }
  async list() {
    return ((await (await this.db).getAll('meta')) as BackupMeta[]).sort((a, b) => b.id.localeCompare(a.id));
  }
  async put(meta: BackupMeta, json: string) {
    const db = await this.db;
    const tx = db.transaction(['meta', 'data'], 'readwrite');
    await Promise.all([tx.objectStore('meta').put(meta), tx.objectStore('data').put(json, meta.id), tx.done]);
  }
  async get(id: string) {
    return (await (await this.db).get('data', id)) as string | undefined;
  }
  async remove(id: string) {
    const db = await this.db;
    const tx = db.transaction(['meta', 'data'], 'readwrite');
    await Promise.all([tx.objectStore('meta').delete(id), tx.objectStore('data').delete(id), tx.done]);
  }
}

export class MemoryBackupStore implements BackupStore {
  private m = new Map<string, { meta: BackupMeta; json: string }>();
  async list() {
    return [...this.m.values()].map((x) => x.meta).sort((a, b) => b.id.localeCompare(a.id));
  }
  async put(meta: BackupMeta, json: string) {
    this.m.set(meta.id, { meta, json });
  }
  async get(id: string) {
    return this.m.get(id)?.json;
  }
  async remove(id: string) {
    this.m.delete(id);
  }
}

export async function createBackup(repo: Repo, store: BackupStore, auto: boolean, now: Date = new Date()): Promise<{ meta: BackupMeta; json: string }> {
  const snap = await repo.exportSnapshot();
  const json = JSON.stringify(snap);
  const records = Object.values(snap.stores).reduce((a, xs) => a + (xs as unknown[]).length, 0);
  const meta: BackupMeta = { id: nowISO(now), date: todayISO(now), bytes: json.length, records, auto };
  await store.put(meta, json);
  const all = await store.list();
  for (const old of all.slice(KEEP_BACKUPS)) await store.remove(old.id);
  return { meta, json };
}

/** Run the weekly backup if due. Returns the backup made, or null. */
export async function maybeWeeklyBackup(repo: Repo, store: BackupStore, now: Date = new Date()): Promise<{ meta: BackupMeta; json: string } | null> {
  const last = getDeviceState().lastAutoBackupAt;
  if (last && now.getTime() - Date.parse(last) < BACKUP_INTERVAL_DAYS * 86_400_000) return null;
  const b = await createBackup(repo, store, true, now);
  setDeviceState({ lastAutoBackupAt: nowISO(now) });
  return b;
}
