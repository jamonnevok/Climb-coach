/**
 * Device-only state (never synced, never exported): Gist id, last sync, last automatic backup,
 * Garmin import status. Kept in localStorage so frequent updates don't bump the synced
 * settings record (which would make a stale copy win last-write-wins on the other device).
 */
export interface DeviceState {
  gistId: string | null;
  autoSync: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastAutoBackupAt: string | null;
  garminFetchedAt: string | null;
  garminDays: number;
  decimalComma: boolean;
  autoDownloadBackup: boolean;
}

const KEY = 'climbcoach.device';
const DEFAULTS: DeviceState = {
  gistId: null,
  autoSync: true,
  lastSyncAt: null,
  lastSyncError: null,
  lastAutoBackupAt: null,
  garminFetchedAt: null,
  garminDays: 0,
  decimalComma: true,
  autoDownloadBackup: false,
};

let memory: DeviceState | null = null; // fallback when localStorage is unavailable (tests, private mode)

export function getDeviceState(): DeviceState {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<DeviceState>) : {}) };
  } catch {
    return { ...DEFAULTS, ...(memory ?? {}) };
  }
}

export function setDeviceState(patch: Partial<DeviceState>): DeviceState {
  const next = { ...getDeviceState(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    memory = next;
  }
  return next;
}
