/**
 * Typed access to the editable JSON config files.
 * To change a rule, threshold, exercise or template, edit the JSON — not the engine code.
 */
import thresholdsJson from './thresholds.json';
import referencesJson from './references.json';
import exercisesJson from './exercises.json';
import normsJson from './norms.json';
import rulesJson from './adaptation-rules.json';
import templatesJson from './plan-templates.json';
import rehabJson from './rehab-protocols.json';
import type { ExerciseDef, Grip, ItemRole, SessionKind } from '../data/schema';

export type Thresholds = typeof thresholdsJson;
export const thresholds: Thresholds = thresholdsJson;

export interface Reference {
  citation: string;
  topic: string;
}
export const references: Record<string, Reference> = Object.fromEntries(
  Object.entries(referencesJson).filter(([k]) => !k.startsWith('_')),
) as Record<string, Reference>;

export const exerciseLibrary: ExerciseDef[] = exercisesJson as ExerciseDef[];

export interface GradeNorm {
  maxHangTotalPctBW: number;
  pullup1RMAddedPctBW: number;
  lockoffS: number;
  frontLeverLevel: number;
  repeatersRemovedPctBW: number;
}
export type Norms = Omit<typeof normsJson, 'bySportGrade'> & { bySportGrade: Record<string, GradeNorm> };
export const norms: Norms = normsJson as Norms;

export type Rules = typeof rulesJson;
export const rules: Rules = rulesJson;

/** Prescription keys understood by planGenerator.ts (see prescribeLoad). */
export type RxKey =
  | 'max_hang'
  | 'max_hang_open'
  | 'max_hang_maint'
  | 'min_edge'
  | 'one_arm'
  | 'nohang'
  | 'tendon_iso'
  | 'pocket3'
  | 'pocket2'
  | 'repeaters'
  | 'pullup'
  | 'finger_curls'
  | 'bw'
  | 'bw_added0'
  | 'none';

export interface TemplateItem {
  ex: string;
  role: ItemRole;
  sets?: number;
  reps?: number;
  totalS?: number;
  grip?: Grip;
  rx?: RxKey;
  priority?: number;
  fromWeek?: number;
  weakness?: string;
  requires?: 'tindeq';
}

export interface SessionTemplate {
  id: string;
  title: string;
  kind: SessionKind;
  location: 'home' | 'gym' | 'outdoor';
  durationMin: number;
  sessionRPE: number;
  items: TemplateItem[];
  warmup?: 'finger_only';
  optional?: boolean;
}

/** Per block kind: key "2"/"3"/"4" = sessions per week. "3+free" means the 3-session list plus a free session. */
export interface BlockTemplates {
  [count: string]: SessionTemplate[] | '3+free' | SessionTemplate | undefined;
  bonus?: SessionTemplate;
}

export interface PlanTemplates {
  testSessions: { a: SessionTemplate; b: SessionTemplate };
  prehab: SessionTemplate;
  outdoor: SessionTemplate;
  outdoorProjecting: SessionTemplate;
  freeSession: SessionTemplate;
  blocks: Record<string, BlockTemplates>;
  aliases: Record<string, string>;
}
export const planTemplates: PlanTemplates = templatesJson as unknown as PlanTemplates;

export interface RehabStage {
  stage: number;
  minDays: number;
  title: string;
  content: string[];
}
export interface RehabProtocol {
  name: string;
  references: string[];
  evidence: string;
  stages: RehabStage[];
}
export const rehab: { disclaimer: string; protocols: Record<string, RehabProtocol> } = rehabJson;
