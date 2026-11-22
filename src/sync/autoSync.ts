/**
 * Background orchestration (no server): weekly backup + Gist sync when the app opens,
 * when it comes back to the foreground, every 10 minutes while visible, and ~20 s after
 * local changes. Never runs two syncs at once. Errors are kept in device state and shown
 * on Settings > Data; they never block the app.
 */
import type { Repo } from '../data/repo';
import { autoDownload } from './download';
import { IdbBackupStore, maybeWeeklyBackup, type BackupStore } from './backup';
import { getDeviceState, setDeviceState } from './deviceState';
import { GistClient, getToken, sync, type SyncResult } from './gist';

let running: Promise<SyncResult | null> | null = null;
let backupStore: BackupStore | null = null;

export function getBackupStore(): BackupStore {
  if (!backupStore) backupStore = new IdbBackupStore();
  return backupStore;
}

export function syncConfigured(): boolean {
  return !!getToken() && !!getDeviceState().gistId;
}

/** Sync now (manual or automatic). Returns null if not configured or offline. */
export function syncNow(repo: Repo): Promise<SyncResult | null> {
  if (running) return running;
  const token = getToken();
  const { gistId } = getDeviceState();
  if (!token || !gistId) return Promise.resolve(null);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(null);
  running = sync(repo, new GistClient(token), gistId)
    .catch((e: unknown) => {
      setDeviceState({ lastSyncError: e instanceof Error ? e.message : String(e) });
      throw e;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** `changed` = the pull brought new data (the UI must refresh). */
export async function backgroundTick(repo: Repo): Promise<{ synced: boolean; changed: boolean; backedUp: boolean }> {
  let backedUp = false;
  try {
    const b = await maybeWeeklyBackup(repo, getBackupStore());
    if (b) {
      backedUp = true;
      if (getDeviceState().autoDownloadBackup) autoDownload(`climb-coach-backup-${b.meta.date}.json`, b.json, 'application/json');
    }
  } catch {
    /* backup failures are retried next tick */
  }
  let synced = false;
  let changed = false;
  if (getDeviceState().autoSync && syncConfigured()) {
    try {
      const r = await syncNow(repo);
      synced = !!r;
      changed = !!r && pulledChanges(r);
    } catch {
      synced = false;
    }
  }
  return { synced, changed, backedUp };
}

export function pulledChanges(r: SyncResult): boolean {
  return (r.pulled ? r.pulled.added + r.pulled.updated > 0 : false) || (r.garmin ? r.garmin.saved > 0 : false);
}
