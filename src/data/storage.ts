/**
 * Storage abstraction. The app uses IndexedDB (db.ts); tests and engines use the
 * in-memory backend below. Both implement the same interface, so every engine
 * can be unit-tested without a browser.
 */
import type { StoreMap, StoreName } from './schema';

export interface StorageBackend {
  get<K extends StoreName>(store: K, id: string): Promise<StoreMap[K] | undefined>;
  getAll<K extends StoreName>(store: K): Promise<StoreMap[K][]>;
  put<K extends StoreName>(store: K, value: StoreMap[K]): Promise<void>;
  putMany<K extends StoreName>(store: K, values: StoreMap[K][]): Promise<void>;
  /** Hard delete — only used by purge/replace; the app uses tombstones. */
  remove(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export class MemoryStorage implements StorageBackend {
  private data = new Map<StoreName, Map<string, unknown>>();
  private meta = new Map<string, unknown>();

  private s(store: StoreName) {
    let m = this.data.get(store);
    if (!m) this.data.set(store, (m = new Map()));
    return m;
  }
  private clone<T>(v: T): T {
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  }
  async get<K extends StoreName>(store: K, id: string) {
    return this.clone(this.s(store).get(id) as StoreMap[K] | undefined);
  }
  async getAll<K extends StoreName>(store: K) {
    return [...this.s(store).values()].map((v) => this.clone(v)) as StoreMap[K][];
  }
  async put<K extends StoreName>(store: K, value: StoreMap[K]) {
    this.s(store).set((value as { id: string }).id, this.clone(value));
  }
  async putMany<K extends StoreName>(store: K, values: StoreMap[K][]) {
    for (const v of values) await this.put(store, v);
  }
  async remove(store: StoreName, id: string) {
    this.s(store).delete(id);
  }
  async clear(store: StoreName) {
    this.s(store).clear();
  }
  async getMeta<T>(key: string) {
    return this.clone(this.meta.get(key) as T | undefined);
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, this.clone(value));
  }
}
