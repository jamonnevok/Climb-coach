/**
 * DATA MODEL — single source of truth for persisted types.
 *
 * Rules for future edits (human or AI):
 *  1. Any change to a persisted shape => bump SCHEMA_VERSION and add a migration
 *     in src/data/migrations.ts (pure function on a Snapshot) + a test.
 *  2. Never rename/remove a field without a migration. Adding an OPTIONAL field
 *     does not strictly need a migration, but bump anyway if defaults must be filled.
 *  3. Every synced record extends BaseRecord (id, createdAt, updatedAt, deleted).
 *     Deletions are tombstones (deleted: true) so sync can propagate them.
 *  4. Units are metric only: kg, mm, cm, s, min, h.
 */
import type { ISODate, ISODateTime } from '../lib/dates';

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Base                                                                */
/* ------------------------------------------------------------------ */

export interface BaseRecord {
  id: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** Tombstone for sync. Deleted records are hidden in the UI and purged after 180 days. */
  deleted?: boolean;
}

/** Wellness scales: 1 = worst, 5 = best (fresh, no soreness, low stress, very motivated). */
export type Scale5 = 1 | 2 | 3 | 4 | 5;
/** Pain: 0 = none ... 10 = worst imaginable. */
export type Pain10 = number;

export type Hand = 'left' | 'right' | 'both';
export type Side = 'left' | 'right';

export type Grip =
  | 'half_crimp'
  | 'open_hand'
  | 'full_crimp'
  | 'pocket_2f_front' // index + middle
  | 'pocket_2f_middle' // middle + ring
  | 'pocket_3f'
  | 'mono'
  | 'pinch'
  | 'sloper'
  | 'jug'
  | 'mixed';

/** Grips tracked separately for A2 protection (volume caps). */
export const RESTRICTED_GRIPS: Grip[] = ['full_crimp', 'pocket_2f_front', 'pocket_2f_middle', 'mono'];

/* ------------------------------------------------------------------ */
/* Profile & settings                                                  */
/* ------------------------------------------------------------------ */

export interface Goal {
  discipline: 'sport' | 'boulder';
  style: 'redpoint' | 'onsight' | 'flash';
  grade: string; // French grade, e.g. "7c"
  horizonMonthsMin: number;
  horizonMonthsMax: number;
  /** When set, plan is built backwards from this date with peak/taper. */
  targetDate: ISODate | null;
}

/** Dated profile snapshot. The latest by `date` is authoritative (history kept). */
export interface ProfileEntry extends BaseRecord {
  date: ISODate;
  sex: 'male' | 'female' | 'other';
  birthYear: number;
  heightCm: number;
  bodyMassKg: number;
  gradeSportRedpoint: string;
  gradeSportOnsight: string;
  gradeBoulderOutdoor: string; // Fontainebleau
  gradeBoulderBoard: string; // Fontainebleau, board-specific
  boardName: string; // e.g. "Kilter"
  yearsStructuredTraining: number;
  goal: Goal;
  strengths: string[];
  suspectedWeaknesses: string[];
  preferredTerrain: string[];
  preferredHolds: Grip[];
  injuryHistory: string;
  notes: string;
}

export type TrainingMode = 'normal' | 'low_capacity' | 'newborn' | 'return_ramp';

export interface ColdStartSeed {
  /** Typical week over the last 4 weeks, entered at onboarding. */
  sessionsPerWeek: number;
  avgDurationMin: number;
  avgSessionRPE: number; // 0-10
  fingerSessionsPerWeek: number;
  /** Effective time under finger load per finger session (hangs + hard climbing estimate). */
  fingerMinutesPerSession: number;
  fingerIntensity: 'low' | 'moderate' | 'high' | 'max';
  seededAt: ISODate;
}

export interface ReminderSettings {
  morningCheckin: string | null; // "HH:MM" local, null = off
  sessionReminder: string | null;
  weeklyReview: string | null; // Sunday at HH:MM
}

/** Singleton: id = 'settings'. */
export interface Settings extends BaseRecord {
  sessionsPerWeek: number;
  weekdaySessionMin: number;
  weekendSessionMin: number;
  /** Preferred training weekdays, 0 = Monday. */
  preferredDays: number[];
  /** Recurring unavailable weekdays, 0 = Monday. */
  unavailableWeekdays: number[];
  theme: 'dark' | 'light';
  accent: string; // hex
  mode: TrainingMode;
  modeChangedAt: ISODate | null;
  /** Date from which the newborn preset is suggested. */
  newbornSuggestFrom: ISODate | null;
  returnRampStartedAt: ISODate | null;
  sleepBaselineH: number | null; // personal baseline; null = computed from 28-day median
  reminders: ReminderSettings;
  coldStart: ColdStartSeed | null;
  onboardingDone: boolean;
  tindeq: { deviceId: string | null; deviceName: string | null };
  sync: { gistId: string | null; lastSyncAt: ISODateTime | null; autoSync: boolean };
  backup: { lastAutoBackupAt: ISODateTime | null };
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

export type BenchmarkType =
  | 'max_hang_20mm_10s_hc' // added kg (negative = assisted), half crimp, both hands
  | 'weighted_pullup' // added kg, 1RM (or estimated from 3RM)
  | 'repeaters_7_3_20mm' // kg REMOVED (assistance), reps to failure recorded
  | 'max_lockoff' // seconds at 90° (or added kg)
  | 'front_lever' // progression level (see FRONT_LEVER_LEVELS)
  | 'power_board_max_move' // Kilter/board max move, cm or board grade
  | 'power_campus' // max reach rungs/cm
  | 'tindeq_peak_force' // kg per hand
  | 'tindeq_critical_force'; // kg per hand (experimental)

export const FRONT_LEVER_LEVELS = [
  'none',
  'tuck',
  'advanced_tuck',
  'one_leg',
  'straddle',
  'full',
] as const;

export type BenchmarkUnit = 'kg_added' | 'kg_removed' | 'kg' | 's' | 'level' | 'cm' | 'grade' | 'reps';

export interface BenchmarkResult extends BaseRecord {
  date: ISODate;
  type: BenchmarkType;
  value: number;
  unit: BenchmarkUnit;
  /** Body mass at test time; used to express % BW. */
  bodyMassKg: number;
  hand?: Hand;
  /** For pull-ups: reps performed (1 = true 1RM, 3 = 3RM -> Epley estimate). */
  reps?: number;
  /** For repeaters: completed reps before failure. */
  repsToFailure?: number;
  /** Board grade string for power_board_max_move when unit = 'grade'. */
  gradeText?: string;
  source: 'manual' | 'tindeq';
  forceCurveId?: string;
  blockId?: string;
  notes?: string;
}

export type QuestionId =
  | 'technique_footwork'
  | 'technique_body_position'
  | 'technique_outdoor_transfer'
  | 'power_dynamic'
  | 'power_contact_strength'
  | 'finger_small_crimps'
  | 'finger_pockets'
  | 'power_endurance_pump'
  | 'style_vertical'
  | 'style_steep'
  | 'style_slab'
  | 'reading_tactics'
  | 'resting'
  | 'confidence_limit_moves'
  | 'recovery_between_attempts';

export interface QuestionnaireResponse extends BaseRecord {
  date: ISODate;
  /** 1 = clear weakness ... 5 = clear strength */
  answers: Partial<Record<QuestionId, Scale5>>;
  notes?: string;
}

/* ------------------------------------------------------------------ */
/* Exercise library (config + custom)                                  */
/* ------------------------------------------------------------------ */

export type ExerciseCategory =
  | 'finger'
  | 'pull'
  | 'core'
  | 'power'
  | 'technique'
  | 'endurance'
  | 'prehab'
  | 'warmup'
  | 'cooldown'
  | 'antagonist'
  | 'climbing'
  | 'test';

export type TimerKind =
  | 'none'
  | 'reps' // count reps, rest timer between sets
  | 'hang' // single work interval per rep (max hangs, one-arm, min-edge)
  | 'repeaters' // work:rest cycles within a set (e.g. 7:3)
  | 'isometric' // long-duration iso (no-hang, loading pin)
  | 'interval' // generic work/rest
  | 'emom'
  | 'four_by_four'
  | 'arc' // long continuous
  | 'countdown';

export interface TimerPattern {
  kind: TimerKind;
  sets: number;
  reps: number; // reps per set (repeaters: cycles per set)
  workS: number;
  restS: number; // rest between reps within a set
  setRestS: number; // rest between sets
  /** For ARC/EMOM: total duration of the block in seconds. */
  totalS?: number;
}

export type LoadMode =
  | 'added_kg'
  | 'removed_kg'
  | 'percent_bw'
  | 'target_force_kg' // Tindeq / loading pin target
  | 'bodyweight'
  | 'grade'
  | 'none';

export type FingerIntensity = 'none' | 'low' | 'moderate' | 'high' | 'max';
export type EvidenceLevel = 'research' | 'coaching_practice' | 'experimental';

export interface ExerciseDef {
  id: string;
  name: string;
  category: ExerciseCategory;
  timer: TimerPattern;
  loadMode: LoadMode;
  defaultGrip?: Grip;
  gripOptions?: Grip[];
  edgeMm?: number;
  equipment: string[];
  fingerIntensity: FingerIntensity;
  /** Short coaching rationale shown in the UI. */
  rationale: string;
  /** Reference ids from src/config/references.json. Empty => evidence 'coaching_practice'. */
  references: string[];
  evidence: EvidenceLevel;
  cues?: string[];
  custom?: boolean;
}

/** User-built exercises, stored in IndexedDB and merged with the JSON library. */
export interface CustomExercise extends BaseRecord, Omit<ExerciseDef, 'id'> {
  custom: true;
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export type BlockKind =
  | 'strength'
  | 'power'
  | 'power_endurance'
  | 'performance'
  | 'projecting'
  | 'maintenance'
  | 'newborn'
  | 'return_ramp'
  | 'taper';

export interface MacroBlock {
  id: string;
  kind: BlockKind;
  startDate: ISODate;
  weeks: number; // 4-6 incl. deload
  /** 0-based index of the deload week within the block (usually last). null = none. */
  deloadWeekIndex: number | null;
  focus: string[]; // e.g. ['finger_strength','bouldering','technique']
  retestAtEnd: boolean;
  userInserted?: boolean;
}

export type SessionKind =
  | 'training'
  | 'technique'
  | 'free'
  | 'projecting'
  | 'outdoor'
  | 'other_sport'
  | 'prehab'
  | 'test';

export type ItemRole = 'warmup' | 'main' | 'accessory' | 'prehab' | 'cooldown';

export interface PlannedItem {
  id: string;
  exerciseId: string;
  role: ItemRole;
  timer: TimerPattern;
  load: { mode: LoadMode; value: number | null };
  grip?: Grip;
  edgeMm?: number;
  rpeTarget?: number;
  notes?: string;
}

export type PlannedStatus = 'planned' | 'done' | 'missed' | 'dropped' | 'moved';

export interface PlannedSession {
  id: string;
  date: ISODate;
  kind: SessionKind;
  title: string;
  estDurationMin: number;
  estSessionRPE: number;
  fingerIntensity: FingerIntensity;
  /** Estimated finger-load units (see engine/load.ts). */
  estFingerLoad: number;
  location: 'home' | 'gym' | 'outdoor';
  items: PlannedItem[];
  status: PlannedStatus;
  movedFrom?: ISODate;
  logId?: string;
  optional?: boolean; // e.g. newborn-mode bonus climbing sessions
}

export interface PlanWeek {
  id: string;
  blockId: string;
  index: number; // within block
  startDate: ISODate; // Monday
  isDeload: boolean;
  unavailableDays: ISODate[];
  outdoorDays: ISODate[];
  sessions: PlannedSession[];
  validated: boolean;
  validatedAt: ISODateTime | null;
  /** Generator/adaptation notes (caps applied, tests inserted, ...). Optional: no migration needed. */
  notes?: string[];
  /** Finger-load caps that applied when the week was generated (FLU). */
  caps?: { finger: number; restricted: number; estFinger: number; estRestricted: number };
}

export interface Plan extends BaseRecord {
  status: 'draft' | 'active' | 'archived';
  version: number;
  startDate: ISODate;
  targetDate: ISODate | null;
  macro: MacroBlock[];
  /** Index in `macro` of the block detailed in `weeks`. */
  currentBlockIndex: number;
  /** Detailed weeks for the CURRENT block only. */
  weeks: PlanWeek[];
  generatorInputsHash: string;
}

export interface PlanVersion extends BaseRecord {
  planId: string;
  version: number;
  date: ISODate;
  reason: string;
  actor: 'user' | 'proposal' | 'generator';
  proposalId?: string;
  snapshot: Plan;
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export interface SetLog {
  id: string;
  exerciseId: string;
  /** PlannedItem this set belongs to (guided sessions). Optional: no migration needed. */
  itemId?: string;
  setIndex: number;
  completed: boolean;
  reps: number; // completed reps / cycles
  workS: number; // work seconds per rep
  load: { mode: LoadMode; value: number | null };
  grip?: Grip;
  edgeMm?: number;
  hand?: Hand;
  rpe?: number; // 0-10
  fingerFeeling?: Scale5;
  peakForceKg?: number;
  forceCurveId?: string;
  endedByForceDrop?: boolean;
  at: ISODateTime;
}

export interface SessionLog extends BaseRecord {
  date: ISODate;
  startedAt: ISODateTime | null;
  kind: SessionKind;
  plannedSessionId?: string;
  durationMin: number;
  sessionRPE: number; // 0-10 (Foster CR-10)
  location: 'home' | 'gym' | 'outdoor';
  sets: SetLog[];
  /** Estimated climbing finger exposure when no sets are logged (min x intensity). */
  climbingFingerMin?: number;
  climbingFingerIntensity?: FingerIntensity;
  /** Computed & cached at save time (engine/load.ts); recomputable. */
  globalLoad: number;
  fingerLoad: number;
  restrictedGripLoad: number;
  source: 'guided' | 'manual' | 'quick';
  otherSportName?: string;
  notes?: string;
}

export type Angle = 'slab' | 'vertical' | 'slight_overhang' | 'overhang' | 'steep' | 'roof';

export interface ClimbLog extends BaseRecord {
  date: ISODate;
  sessionLogId?: string;
  name?: string;
  discipline: 'boulder' | 'route';
  grade: string; // French (routes) / Font (boulders)
  style: 'onsight' | 'flash' | 'redpoint' | 'attempt';
  angle: Angle;
  boardAngleDeg?: number;
  setting: 'indoor' | 'outdoor' | 'board';
  board?: string; // 'Kilter', 'Spray wall'
  rock?: 'limestone' | 'granite' | 'sandstone' | 'gneiss' | 'conglomerate' | 'other';
  grips: Grip[];
  /** Tries (boulders) or burns (routes). */
  attempts: number;
  notes?: string;
}

/** One per calendar day (id = `checkin-${date}`). */
export interface DailyCheckin extends BaseRecord {
  date: ISODate;
  sleepQuality: Scale5;
  fatigue: Scale5; // 5 = fresh
  soreness: Scale5; // 5 = none
  stress: Scale5; // 5 = calm
  motivation: Scale5;
  fingerStatus: Scale5; // 5 = perfect
  notes?: string;
}

/** Night ending on `date` morning. id = `sleep-${date}-${source}`. */
export interface SleepRecord extends BaseRecord {
  date: ISODate;
  durationH: number;
  quality?: Scale5;
  sleepScore?: number; // Garmin 0-100
  restingHr?: number;
  hrvMs?: number;
  bodyBatteryHigh?: number;
  source: 'manual' | 'garmin';
}

/* ------------------------------------------------------------------ */
/* Body, pain, injuries                                                */
/* ------------------------------------------------------------------ */

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'little';
export type Pulley = 'A2' | 'A3' | 'A4' | 'other';

export type BodyLocation =
  | { region: 'finger'; side: Side; finger: FingerName; structure: Pulley }
  | { region: 'wrist' | 'elbow' | 'shoulder'; side: Side; detail?: string }
  | { region: 'skin'; side: Side; finger?: FingerName; detail?: string };

export type PainMoment = 'warmup' | 'during' | 'cooldown' | 'next_morning' | 'rest';

export type RedFlag =
  | 'audible_pop'
  | 'bowstringing'
  | 'swelling'
  | 'pain_at_rest_gt3'
  | 'no_improvement_2w';

export interface PainEntry extends BaseRecord {
  date: ISODate;
  at: ISODateTime;
  location: BodyLocation;
  moment: PainMoment;
  pain: Pain10;
  redFlags: RedFlag[];
  aggravatingGrip?: Grip;
  sessionLogId?: string;
  injuryId?: string;
  notes?: string;
}

export interface InjuryEpisode extends BaseRecord {
  start: ISODate;
  end: ISODate | null;
  location: BodyLocation;
  cause: string;
  diagnosis?: string; // as given by a professional
  protocolId?: string; // return-to-climbing protocol (config)
  protocolStage?: number;
  status: 'active' | 'resolved';
  notes?: string;
}

/* ------------------------------------------------------------------ */
/* Proposals & reviews                                                 */
/* ------------------------------------------------------------------ */

export type ProposalKind =
  | 'reschedule'
  | 'drop'
  | 'deload'
  | 'downgrade'
  | 'weekly_adjustment'
  | 'progression'
  | 'pain_modify'
  | 'pain_stop'
  | 'mode_change'
  | 'rehab'
  | 'retest';

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'edited' | 'expired';

/** A change the engine proposes; nothing is applied until the user accepts. */
export interface Proposal extends BaseRecord {
  kind: ProposalKind;
  status: ProposalStatus;
  title: string;
  reason: string;
  triggers: string[];
  /** Structured change, interpreted by engine/adaptation.ts applyProposal(). JSON-safe. */
  payload: Record<string, unknown>;
  expiresOn: ISODate | null;
  resolvedAt: ISODateTime | null;
  planVersionId?: string;
}

export interface WeeklyReviewSummary {
  globalLoad: number;
  fingerLoad: number;
  globalACWR: number | null;
  fingerACWR: number | null;
  avgSleepH: number | null;
  avgReadiness: number | null;
  maxPain: number;
  adherencePct: number;
  benchmarkNotes: string[];
}

export interface WeeklyReview extends BaseRecord {
  weekStart: ISODate;
  summary: WeeklyReviewSummary;
  proposalIds: string[];
  completedAt: ISODateTime | null;
}

/* ------------------------------------------------------------------ */
/* Tindeq                                                              */
/* ------------------------------------------------------------------ */

/** Raw force curve, stored separately from SetLog to keep logs light. */
export interface ForceCurve extends BaseRecord {
  takenAt: ISODateTime;
  hand: Hand;
  /** Milliseconds since start of measurement. */
  t: number[];
  /** Force in kg. */
  f: number[];
  peakKg: number;
  meanKg: number;
  context: 'test' | 'set' | 'free';
  sessionLogId?: string;
  setId?: string;
}

/* ------------------------------------------------------------------ */
/* Stores & snapshot                                                   */
/* ------------------------------------------------------------------ */

export interface StoreMap {
  profile: ProfileEntry;
  settings: Settings;
  benchmarks: BenchmarkResult;
  questionnaires: QuestionnaireResponse;
  customExercises: CustomExercise;
  plans: Plan;
  planVersions: PlanVersion;
  sessions: SessionLog;
  climbs: ClimbLog;
  checkins: DailyCheckin;
  sleep: SleepRecord;
  pain: PainEntry;
  injuries: InjuryEpisode;
  proposals: Proposal;
  weeklyReviews: WeeklyReview;
  forceCurves: ForceCurve;
}

export type StoreName = keyof StoreMap;

export const STORE_NAMES: StoreName[] = [
  'profile',
  'settings',
  'benchmarks',
  'questionnaires',
  'customExercises',
  'plans',
  'planVersions',
  'sessions',
  'climbs',
  'checkins',
  'sleep',
  'pain',
  'injuries',
  'proposals',
  'weeklyReviews',
  'forceCurves',
];

/** Stores with a `date` field get a date index. */
export const DATED_STORES: StoreName[] = [
  'profile',
  'benchmarks',
  'questionnaires',
  'planVersions',
  'sessions',
  'climbs',
  'checkins',
  'sleep',
  'pain',
];

/** Portable dump used for export, backups, sync and migrations. */
export interface Snapshot {
  app: 'climb-coach';
  schemaVersion: number;
  exportedAt: ISODateTime;
  deviceId: string;
  stores: { [K in StoreName]: StoreMap[K][] };
}

/** Non-synced, device-local values (never exported, never committed). */
export interface LocalSecrets {
  gistToken: string | null;
}
