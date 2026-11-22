/**
 * IndexedDB backend (via the tiny `idb` wrapper).
 *
 * Two independent version numbers:
 *  - IDB_VERSION: structural (object stores / indexes). Bump only when adding a store or index.
 *  - SCHEMA_VERSION (schema.ts): shape of records. Data migrations run in openAppStorage().
 *
 * Opening sequence:
 *  1. open DB (structural upgrade creates any missing stores/indexes);
 *  2. read meta.schemaVersion (absent => fresh install or v0);
 *  3. if < SCHEMA_VERSION: dump all stores -> migrateSnapshot() -> rewrite atomically,
 *     after saving a pre-migration backup in meta ('preMigrationBackup').
 */
import { openDB, type IDBPDatabase } from 'idb';
import { DATED_STORES, SCHEMA_VERSION, STORE_NAMES, type Snapshot, type StoreMap, type StoreName } from './schema';
import { migrateSnapshot, type RawSnapshot } from './migrations';
import { emptyStores } from './defaults';
import type { StorageBackend } from './storage';
import { newId } from '../lib/ids';
import { nowISO } from '../lib/dates';

export const DB_NAME = 'climb-coach';
export const IDB_VERSION = 1;
const META = '_meta';

export class IdbStorage implements StorageBackend {
  constructor(private db: IDBPDatabase) {}

  async get<K extends StoreName>(store: K, id: string) {
    return (await this.db.get(store, id)) as StoreMap[K] | undefined;
  }
  async getAll<K extends StoreName>(store: K) {
    return (await this.db.getAll(store)) as StoreMap[K][];
  }
  async put<K extends StoreName>(store: K, value: StoreMap[K]) {
    await this.db.put(store, value);
  }
  async putMany<K extends StoreName>(store: K, values: StoreMap[K][]) {
    const tx = this.db.transaction(store, 'readwrite');
    await Promise.all([...values.map((v) => tx.store.put(v)), tx.done]);
  }
  async remove(store: StoreName, id: string) {
    await this.db.delete(store, id);
  }
  async clear(store: StoreName) {
    await this.db.clear(store);
  }
  async getMeta<T>(key: string) {
    const row = (await this.db.get(META, key)) as { key: string; value: T } | undefined;
    return row?.value;
  }
  async setMeta(key: string, value: unknown) {
    await this.db.put(META, { key, value });
  }

  /** Replace ALL stores atomically in one transaction. */
  async replaceAll(stores: Snapshot['stores']) {
    const tx = this.db.transaction([...STORE_NAMES], 'readwrite');
    const ops: Promise<unknown>[] = [];
    for (const name of STORE_NAMES) {
      const os = tx.objectStore(name);
      ops.push(os.clear());
      for (const rec of stores[name] as unknown[]) ops.push(os.put(rec));
    }
    await Promise.all([...ops, tx.done]);
  }

  async dumpStores(): Promise<Snapshot['stores']> {
    const stores = emptyStores();
    for (const name of STORE_NAMES) (stores as Record<string, unknown[]>)[name] = await this.db.getAll(name);
    return stores;
  }
}

export async function openAppStorage(): Promise<IdbStorage> {
  const db = await openDB(DB_NAME, IDB_VERSION, {
    upgrade(database) {
      for (const name of STORE_NAMES) {
        if (!database.objectStoreNames.contains(name)) {
          const os = database.createObjectStore(name, { keyPath: 'id' });
          os.createIndex('updatedAt', 'updatedAt');
          if (DATED_STORES.includes(name)) os.createIndex('date', 'date');
        }
      }
      if (!database.objectStoreNames.contains(META)) database.createObjectStore(META, { keyPath: 'key' });
    },
  });
  const storage = new IdbStorage(db);

  let deviceId = await storage.getMeta<string>('deviceId');
  if (!deviceId) {
    deviceId = newId();
    await storage.setMeta('deviceId', deviceId);
  }

  const stored = await storage.getMeta<number>('schemaVersion');
  const hasData = (await Promise.all(STORE_NAMES.map((n) => db.count(n)))).some((c) => c > 0);

  if (stored === undefined && !hasData) {
    await storage.setMeta('schemaVersion', SCHEMA_VERSION);
  } else if ((stored ?? 0) < SCHEMA_VERSION) {
    const raw: RawSnapshot = {
      app: 'climb-coach',
      schemaVersion: stored ?? 0,
      exportedAt: nowISO(),
      deviceId,
      stores: (await storage.dumpStores()) as unknown as Record<string, unknown[]>,
    };
    await storage.setMeta('preMigrationBackup', raw);
    const migrated = migrateSnapshot(raw);
    await storage.replaceAll(migrated.stores);
    await storage.setMeta('schemaVersion', SCHEMA_VERSION);
    await storage.setMeta('lastMigrationAt', nowISO());
  } else if ((stored ?? 0) > SCHEMA_VERSION) {
    throw new Error(
      `Local data uses schema v${stored} but this app supports v${SCHEMA_VERSION}. Reload to get the latest version.`,
    );
  }
  return storage;
}
