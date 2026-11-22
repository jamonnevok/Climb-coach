import { nowISO, todayISO, type ISODate } from '../lib/dates';
import { newId } from '../lib/ids';
import {
  SCHEMA_VERSION,
  STORE_NAMES,
  type ProfileEntry,
  type Settings,
  type Snapshot,
  type StoreMap,
} from './schema';

export const SETTINGS_ID = 'settings';

export function defaultSettings(now: Date = new Date()): Settings {
  const ts = nowISO(now);
  return {
    id: SETTINGS_ID,
    createdAt: ts,
    updatedAt: ts,
    sessionsPerWeek: 3,
    weekdaySessionMin: 90,
    weekendSessionMin: 180,
    preferredDays: [1, 3, 5], // Tue, Thu, Sat
    unavailableWeekdays: [],
    theme: 'dark',
    accent: '#22d3ee',
    mode: 'normal',
    modeChangedAt: null,
    newbornSuggestFrom: '2027-03-01',
    returnRampStartedAt: null,
    sleepBaselineH: null,
    reminders: { morningCheckin: null, sessionReminder: null, weeklyReview: '19:00' },
    coldStart: null,
    onboardingDone: false,
    tindeq: { deviceId: null, deviceName: null },
    sync: { gistId: null, lastSyncAt: null, autoSync: true },
    backup: { lastAutoBackupAt: null },
  };
}

/**
 * Initial profile pre-filled from the owner's brief. Everything is editable in
 * Settings > Profile; each edit creates a new dated entry (history preserved).
 */
export function initialProfile(date: ISODate = todayISO(), now: Date = new Date()): ProfileEntry {
  const ts = nowISO(now);
  return {
    id: newId(),
    createdAt: ts,
    updatedAt: ts,
    date,
    sex: 'male',
    birthYear: 1994,
    heightCm: 187,
    bodyMassKg: 74,
    gradeSportRedpoint: '7b',
    gradeSportOnsight: '7a',
    gradeBoulderOutdoor: '6B',
    gradeBoulderBoard: '7A',
    boardName: 'Kilter',
    yearsStructuredTraining: 4,
    goal: {
      discipline: 'sport',
      style: 'redpoint',
      grade: '7c',
      horizonMonthsMin: 6,
      horizonMonthsMax: 12,
      targetDate: null,
    },
    strengths: ['route_reading', 'tactics', 'resting', 'falling'],
    suspectedWeaknesses: ['finger_strength', 'power', 'technique_outdoor_transfer'],
    preferredTerrain: ['vertical', 'slight_overhang', 'limestone'],
    preferredHolds: ['half_crimp', 'pocket_2f_middle', 'pocket_3f'],
    injuryHistory: 'Recurring finger pulley strains, mostly A2.',
    notes: '',
  };
}

export function emptyStores(): Snapshot['stores'] {
  const stores = {} as { [K in keyof StoreMap]: StoreMap[K][] };
  for (const name of STORE_NAMES) (stores as Record<string, unknown[]>)[name] = [];
  return stores;
}

export function emptySnapshot(deviceId: string, now: Date = new Date()): Snapshot {
  return {
    app: 'climb-coach',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowISO(now),
    deviceId,
    stores: emptyStores(),
  };
}
