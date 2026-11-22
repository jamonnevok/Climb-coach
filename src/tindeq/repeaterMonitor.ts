/**
 * Live repeater monitor: the guided timer reports work-phase boundaries, the Progressor feeds
 * samples; after each rep we compute its stats and decide whether the set should end
 * (force drop). The UI shows the proposal to end the set — it ends automatically only if
 * the user enabled "auto-end on force drop" for that exercise.
 */
import type { Thresholds } from '../config';
import { detectForceDrop, repStat, type DropDecision, type Pt, type RepStat } from './forceAnalysis';

export class RepeaterMonitor {
  private points: Pt[] = [];
  private reps: RepStat[] = [];
  private workStart: number | null = null;

  constructor(private targetKg: number | null, private config?: Thresholds) {}

  addSample(p: Pt): void {
    this.points.push(p);
  }

  workStarted(tMs: number): void {
    this.workStart = tMs;
  }

  /** Call at the end of each work phase. */
  workEnded(tMs: number): { rep: RepStat; decision: DropDecision } | null {
    if (this.workStart === null) return null;
    const rep = repStat(this.points, this.reps.length, this.workStart, tMs, this.config);
    this.reps.push(rep);
    this.workStart = null;
    return { rep, decision: detectForceDrop(this.reps, this.targetKg, this.config) };
  }

  get repStats(): RepStat[] {
    return [...this.reps];
  }

  get samples(): Pt[] {
    return [...this.points];
  }
}
