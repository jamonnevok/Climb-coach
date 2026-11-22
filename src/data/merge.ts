/**
 * Last-write-wins merge per record (by `updatedAt`, deterministic tie-break on JSON so
 * both devices converge). Tombstones are records like any other, so deletions propagate.
 * Used by Gist sync (src/sync) and by "Import > Merge".
 *
 * DEVICE-LOCAL FIELDS (module 6): some settings describe THIS device (paired Tindeq,
 * Gist sync state, last automatic backup). They travel inside the settings record but are
 * never taken from the remote copy, so phone and laptop don't overwrite each other.
 */
import { STORE_NAMES, type BaseRecord, type Settings, type Snapshot, type StoreName } from './schema';
import { addDays, nowISO, todayISO } from '../lib/dates';

export interface MergeStats {
  added: number;
  updated: number;
  unchanged: number;
  perStore: Partial<Record<StoreName, { added: number; updated: number }>>;
}

/** Settings keys that belong to one device and are never overwritten by a merge. */
export const DEVICE_LOCAL_SETTINGS_KEYS = ['tindeq', 'sync', 'backup'] as const;

function newer(a: BaseRecord, b: BaseRecord): BaseRecord {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

export function mergeRecords<T extends BaseRecord>(local: T[], remote: T[]): { result: T[]; added: number; updated: number } {
  const map = new Map<string, T>();
  for (const r of local) map.set(r.id, r);
  let added = 0;
  let updated = 0;
  for (const r of remote) {
    const cur = map.get(r.id);
    if (!cur) {
      map.set(r.id, r);
      added++;
    } else {
      const win = newer(cur, r) as T;
      if (win !== cur && JSON.stringify(win) !== JSON.stringify(cur)) {
        map.set(r.id, win);
        updated++;
      }
    }
  }
  return { result: [...map.values()], added, updated };
}

/** Keep this device's local settings keys whatever record won the merge. */
export function keepDeviceLocal(merged: Settings[], local: Settings[]): Settings[] {
  return merged.map((m) => {
    const l = local.find((x) => x.id === m.id);
    if (!l) return m;
    const out = { ...m } as Settings;
    for (const k of DEVICE_LOCAL_SETTINGS_KEYS) (out as unknown as Record<string, unknown>)[k] = l[k];
    return out;
  });
}

/** Both snapshots MUST already be migrated to the same schema version. */
export function mergeSnapshots(local: Snapshot, remote: Snapshot): { merged: Snapshot; stats: MergeStats } {
  if (local.schemaVersion !== remote.schemaVersion) {
    throw new Error(`Cannot merge schema v${local.schemaVersion} with v${remote.schemaVersion}; migrate first.`);
  }
  const stats: MergeStats = { added: 0, updated: 0, unchanged: 0, perStore: {} };
  const stores = { ...local.stores } as Snapshot['stores'];
  for (const name of STORE_NAMES) {
    const l = (local.stores[name] ?? []) as BaseRecord[];
    const r = (remote.stores[name] ?? []) as BaseRecord[];
    const { result, added, updated } = mergeRecords(l, r);
    (stores as Record<string, BaseRecord[]>)[name] = name === 'settings' ? keepDeviceLocal(result as Settings[], local.stores.settings) : result;
    stats.added += added;
    stats.updated += updated;
    stats.unchanged += r.length - added - updated;
    if (added || updated) stats.perStore[name] = { added, updated };
  }
  return { merged: { ...local, exportedAt: nowISO(), stores }, stats };
}

/** Remove tombstones older than `days` (default 180) to keep snapshots small. */
export function purgeTombstones(s: Snapshot, days = 180, today: string = todayISO()): Snapshot {
  const cutoff = addDays(today, -days);
  const stores = { ...s.stores } as Snapshot['stores'];
  for (const name of STORE_NAMES) {
    (stores as Record<string, BaseRecord[]>)[name] = (s.stores[name] as BaseRecord[]).filter((r) => !(r.deleted && r.updatedAt.slice(0, 10) < cutoff));
  }
  return { ...s, stores };
}
