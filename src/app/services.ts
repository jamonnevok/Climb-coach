/**
 * APP SERVICES — the only place where UI actions turn into persisted changes.
 * Every write goes through Repo (timestamps, tombstones -> sync-safe). Plan changes always
 * create a PlanVersion with a date and a reason. Engines stay pure.
 */
import { nowISO, startOfWeek, todayISO, addDays, type ISODate } from '../lib/dates';
import { newId } from '../lib/ids';
import { Repo, type Draft } from '../data/repo';
import {
  STORE_NAMES,
  type BenchmarkResult,
  type ClimbLog,
  type CustomExercise,
  type DailyCheckin,
  type ForceCurve,
  type InjuryEpisode,
  type PainEntry,
  type Plan,
  type ProfileEntry,
  type Proposal,
  type QuestionnaireResponse,
  type SessionLog,
  type Settings,
  type SleepRecord,
  type TrainingMode,
} from '../data/schema';
import type { RawSnapshot } from '../data/migrations';
import { applyProposal, nextModeOnDeactivate, makeProposal, type ProposalDraft } from '../engine/adaptation';
import { withComputedLoads } from '../engine/load';
import {
  advanceBlock,
  buildWeek,
  generatePlan,
  rxContext,
  toPlannedLoads,
  type InsertedPhase,
  type GeneratorInput,
} from '../engine/planGenerator';
import { recordVersion, setSessionStatus, validateAll, validateWeek, allSessions } from '../engine/planOps';
import { isHigh } from '../engine/planRules';
import { setsByExercise, suggestProgression } from '../engine/progression';
import { buildWeeklyReview, countFailedProgressions } from '../engine/weeklyReview';
import { readinessSeries } from '../engine/readiness';
import { webBluetoothAvailable } from '../tindeq/webBluetooth';
import { derive, type AppData, type Derived } from './derive';
import { computeProposals, expiredProposals } from './proposals';

export class Services {
  constructor(public repo: Repo, private clock: () => Date = () => new Date()) {}

  today(): ISODate {
    return todayISO(this.clock());
  }

  /** Load every store except force curves (loaded on demand). */
  async loadAll(): Promise<AppData> {
    const data = {} as AppData;
    for (const name of STORE_NAMES) {
      (data as Record<string, unknown[]>)[name] = name === 'forceCurves' ? [] : await this.repo.list(name);
    }
    return data;
  }

  async boot(): Promise<void> {
    await this.repo.getSettings();
    await this.repo.getProfile();
  }

  async derived(): Promise<{ data: AppData; d: Derived }> {
    const data = await this.loadAll();
    return { data, d: derive(data, this.today()) };
  }

  /* ---------------- settings & profile ---------------- */

  updateSettings(patch: Partial<Omit<Settings, 'id' | 'createdAt' | 'updatedAt'>>) {
    return this.repo.updateSettings(patch);
  }

  updateProfile(patch: Partial<Omit<ProfileEntry, 'id' | 'createdAt' | 'updatedAt' | 'date'>>) {
    return this.repo.updateProfile(patch, this.today());
  }

  saveQuestionnaire(answers: QuestionnaireResponse['answers'], notes?: string) {
    return this.repo.save('questionnaires', { date: this.today(), answers, notes });
  }

  saveCustomExercise(ex: Draft<CustomExercise> | CustomExercise) {
    return this.repo.save('customExercises', { ...ex, custom: true });
  }

  /* ---------------- daily inputs ---------------- */

  saveCheckin(c: Omit<DailyCheckin, 'id' | 'createdAt' | 'updatedAt'>) {
    return this.repo.save('checkins', { ...c, id: `checkin-${c.date}` });
  }

  saveSleep(s: Omit<SleepRecord, 'id' | 'createdAt' | 'updatedAt' | 'source'>) {
    return this.repo.save('sleep', { ...s, source: 'manual', id: `sleep-${s.date}-manual` });
  }

  saveBenchmark(b: Draft<BenchmarkResult>) {
    return this.repo.save('benchmarks', b);
  }

  savePain(p: Draft<PainEntry>) {
    return this.repo.save('pain', p);
  }

  saveInjury(i: Draft<InjuryEpisode> | InjuryEpisode) {
    return this.repo.save('injuries', i);
  }

  saveForceCurve(c: Draft<ForceCurve>) {
    return this.repo.save('forceCurves', c);
  }

  async forceCurves(): Promise<ForceCurve[]> {
    return this.repo.list('forceCurves');
  }

  softDelete(store: Parameters<Repo['softDelete']>[0], id: string) {
    return this.repo.softDelete(store, id);
  }

  /* ---------------- sessions & climbs ---------------- */

  /**
   * Save a session log: computes and caches loads (Foster sRPE + finger index), links climbs,
   * marks the planned session as done and creates progression proposals.
   */
  async saveSession(draft: Draft<SessionLog> | SessionLog, climbs: Draft<ClimbLog>[] = []): Promise<SessionLog> {
    const { data, d } = await this.derived();
    const id = draft.id ?? newId();
    const linked = climbs.map((c) => ({ ...c, id: c.id ?? newId(), sessionLogId: id, date: c.date ?? draft.date }));
    const savedClimbs = await this.repo.saveMany('climbs', linked);
    const allClimbs = [...data.climbs.filter((c) => c.sessionLogId === id && !savedClimbs.some((s) => s.id === c.id)), ...savedClimbs];
    const base = { ...draft, id, createdAt: draft.createdAt ?? nowISO(this.clock()), updatedAt: nowISO(this.clock()), deleted: false } as SessionLog;
    const log = await this.repo.save('sessions', withComputedLoads(base, allClimbs, d.ctx));
    if (log.plannedSessionId && d.plan) {
      const p = setSessionStatus(d.plan, log.plannedSessionId, 'done', log.id);
      await this.repo.save('plans', p);
    }
    await this.proposeProgressions(log, data, d);
    return log;
  }

  /** Recompute a session's cached loads (after adding/removing climbs). */
  async recomputeSession(sessionId: string): Promise<void> {
    const { data, d } = await this.derived();
    const s = data.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    await this.repo.save('sessions', withComputedLoads(s, data.climbs.filter((c) => c.sessionLogId === sessionId), d.ctx));
  }

  async saveClimb(c: Draft<ClimbLog> | ClimbLog): Promise<ClimbLog> {
    const saved = await this.repo.save('climbs', c);
    if (saved.sessionLogId) await this.recomputeSession(saved.sessionLogId);
    return saved;
  }

  async deleteClimb(c: ClimbLog): Promise<void> {
    await this.repo.softDelete('climbs', c.id);
    if (c.sessionLogId) await this.recomputeSession(c.sessionLogId);
  }

  private async proposeProgressions(log: SessionLog, data: AppData, d: Derived): Promise<void> {
    if (!d.plan || !log.sets.length) return;
    const future = allSessions(d.plan).filter((s) => s.status === 'planned' && s.date > log.date);
    const prevLogs = data.sessions.filter((s) => s.id !== log.id && s.date < log.date).sort((a, b) => b.date.localeCompare(a.date));
    for (const [exId, sets] of setsByExercise(log.sets)) {
      const ex = d.lib.get(exId);
      const item = future.flatMap((s) => s.items).find((i) => i.exerciseId === exId && i.load.value !== null);
      if (!ex || !item) continue;
      const prev = prevLogs.find((s) => s.sets.some((x) => x.exerciseId === exId));
      const sug = suggestProgression({
        exercise: ex,
        lastSets: sets,
        previousFailed: !!prev?.sets.some((x) => x.exerciseId === exId && !x.completed),
        bodyMassKg: d.profile.bodyMassKg,
        current: item.load,
        fingerStatusLow: d.readinessToday.fingerLow,
        recentFingerPainMax: d.fingerPainRecent,
      });
      if ((sug.action !== 'increase' && sug.action !== 'decrease') || sug.newValue === null) continue;
      const key = `progression:${log.id}:${exId}`;
      const p = makeProposal('progression', `${ex.name}: ${item.load.value} → ${sug.newValue} kg`, sug.reason, ['progression'],
        { key, exerciseId: exId, mode: item.load.mode, value: sug.newValue, fromDate: addDays(log.date, 1) }, addDays(log.date, 7));
      await this.repo.save('proposals', p);
    }
  }

  /* ---------------- plan ---------------- */

  private generatorInput(data: AppData, d: Derived, extra: Partial<GeneratorInput> = {}): GeneratorInput {
    return {
      today: d.today,
      profile: d.profile,
      settings: d.settings,
      benchmarks: data.benchmarks,
      ranking: d.ranking,
      loads: d.loads,
      library: d.lib,
      ctx: d.ctx,
      hasTindeq: !!d.settings.tindeq.deviceId || webBluetoothAvailable(),
      ...extra,
    };
  }

  private async persistPlan(plan: Plan, reason: string, actor: 'user' | 'proposal' | 'generator', proposalId?: string): Promise<Plan> {
    const { plan: bumped, version } = recordVersion(plan, reason, actor, proposalId, this.today());
    await this.repo.save('planVersions', version);
    return this.repo.save('plans', bumped);
  }

  /** Generate (or regenerate) the plan (same plan id; every previous state is kept in planVersions). */
  async generatePlan(reason = 'Plan generated', phases?: InsertedPhase[]): Promise<Plan> {
    const { data, d } = await this.derived();
    const previous = d.plan;
    const generated = generatePlan(this.generatorInput(data, d, { previous, phases }));
    // The plan starts on this week's Monday: days already past are skipped, not "missed".
    const plan: Plan = {
      ...generated,
      weeks: generated.weeks.map((w) => {
        const past = w.sessions.filter((s) => s.date < d.today && s.status === 'planned');
        if (!past.length) return w;
        return {
          ...w,
          sessions: w.sessions.map((s) => (s.date < d.today && s.status === 'planned' ? { ...s, status: 'dropped' as const } : s)),
          notes: [...(w.notes ?? []), `${past.length} session(s) before the plan start date skipped.`],
        };
      }),
    };
    return this.persistPlan({ ...plan, version: previous?.version ?? 0 }, reason, 'generator');
  }

  async insertProjectingPhase(start: ISODate, weeks: number): Promise<Plan> {
    const { d } = await this.derived();
    const existing = (d.plan?.macro ?? []).filter((b) => b.userInserted && b.kind === 'projecting').map((b) => ({ kind: 'projecting' as const, start: b.startDate, weeks: b.weeks }));
    return this.generatePlan(`Projecting phase inserted from ${start} (${weeks} weeks)`, [...existing, { kind: 'projecting', start, weeks }]);
  }

  async removeProjectingPhase(blockId: string): Promise<Plan> {
    const { d } = await this.derived();
    const phases = (d.plan?.macro ?? []).filter((b) => b.userInserted && b.kind === 'projecting' && b.id !== blockId).map((b) => ({ kind: 'projecting' as const, start: b.startDate, weeks: b.weeks }));
    return this.generatePlan('Projecting phase removed', phases);
  }

  async savePlanEdit(plan: Plan, reason: string): Promise<Plan> {
    return this.persistPlan(plan, reason, 'user');
  }

  async validateWeek(weekId: string): Promise<Plan> {
    const { d } = await this.derived();
    if (!d.plan) throw new Error('No plan');
    const w = d.plan.weeks.find((x) => x.id === weekId);
    return this.persistPlan(validateWeek(d.plan, weekId), `Week of ${w?.startDate ?? ''} validated`, 'user');
  }

  async validateAllWeeks(): Promise<Plan> {
    const { d } = await this.derived();
    if (!d.plan) throw new Error('No plan');
    return this.persistPlan(validateAll(d.plan), 'Block validated', 'user');
  }

  /** Rebuild one week from its flags (unavailable/outdoor days). Done sessions are kept. */
  async rebuildWeek(weekId: string): Promise<Plan> {
    const { data, d } = await this.derived();
    const plan = d.plan;
    if (!plan) throw new Error('No plan');
    const week = plan.weeks.find((w) => w.id === weekId);
    if (!week) throw new Error('Week not found');
    const block = plan.macro[plan.currentBlockIndex];
    const earlier = plan.weeks.filter((w) => w.startDate < week.startDate).flatMap((w) => w.sessions);
    const prevSunday = addDays(week.startDate, -1);
    const rebuilt = buildWeek({
      block,
      weekIndex: week.index,
      weekStart: week.startDate,
      isFirstPlanWeek: false,
      settings: d.settings,
      overrides: { unavailableDays: week.unavailableDays, outdoorDays: week.outdoorDays },
      lib: d.lib,
      rx: rxContext(d.profile, data.benchmarks),
      ctx: d.ctx,
      top: d.ranking.top,
      hasTindeq: !!d.settings.tindeq.deviceId || webBluetoothAvailable(),
      cycleIndex: 0,
      capLoads: [...d.loads, ...toPlannedLoads(earlier.filter((s) => s.date >= d.today), d.ctx)],
      prevWeekLastDayHigh: earlier.some((s) => s.date === prevSunday && isHigh(s) && s.kind !== 'prehab'),
    });
    const keep = week.sessions.filter((s) => s.status === 'done' || s.date < d.today);
    const fresh = rebuilt.sessions.filter((s) => s.date >= d.today && !keep.some((k) => k.date === s.date && k.kind !== 'prehab' && s.kind !== 'prehab'));
    const newWeek = { ...rebuilt, id: week.id, sessions: [...keep, ...fresh].sort((a, b) => a.date.localeCompare(b.date)), validated: false, validatedAt: null };
    return this.persistPlan({ ...plan, weeks: plan.weeks.map((w) => (w.id === week.id ? newWeek : w)) }, `Week of ${week.startDate} rebuilt (availability / outdoor days)`, 'user');
  }

  async startNextBlock(): Promise<Plan> {
    const { data, d } = await this.derived();
    if (!d.plan) throw new Error('No plan');
    const next = advanceBlock(d.plan, this.generatorInput(data, d));
    return this.persistPlan({ ...next, version: d.plan.version }, `Next block started: ${next.macro[next.currentBlockIndex]?.kind ?? ''}`, 'generator');
  }

  /** Change training mode; leaving newborn / low-capacity goes through the return ramp. */
  async setMode(mode: TrainingMode): Promise<Plan> {
    const { d } = await this.derived();
    const target = mode === 'normal' && (d.settings.mode === 'newborn' || d.settings.mode === 'low_capacity') ? nextModeOnDeactivate(d.settings.mode) : mode;
    await this.repo.updateSettings({
      mode: target,
      modeChangedAt: this.today(),
      returnRampStartedAt: target === 'return_ramp' ? this.today() : d.settings.returnRampStartedAt,
    });
    return this.generatePlan(`Mode changed: ${d.settings.mode} → ${target}`);
  }

  /** The return ramp ends automatically once its block is over (checked at refresh). */
  private async maybeEndReturnRamp(d: Derived): Promise<boolean> {
    if (d.settings.mode !== 'return_ramp' || !d.settings.returnRampStartedAt) return false;
    if (d.today < addDays(startOfWeek(d.settings.returnRampStartedAt), 7 * 4)) return false;
    await this.repo.updateSettings({ mode: 'normal', modeChangedAt: d.today });
    return true;
  }

  /* ---------------- proposals ---------------- */

  /** Run all daily rules; expire stale proposals. Returns the number of new proposals. */
  async refreshProposals(): Promise<number> {
    let { data, d } = await this.derived();
    if (await this.maybeEndReturnRamp(d)) ({ data, d } = await this.derived());
    for (const p of expiredProposals(data, d.today)) await this.repo.save('proposals', { ...p, status: 'expired', resolvedAt: nowISO(this.clock()) });
    const drafts = computeProposals(data, d);
    for (const p of drafts) await this.repo.save('proposals', p);
    return drafts.length;
  }

  /** Accept (optionally with an edited payload). Applies the change and logs a plan version. */
  async acceptProposal(id: string, editedPayload?: Record<string, unknown>): Promise<void> {
    const { d } = await this.derived();
    const p = await this.repo.get('proposals', id);
    if (!p) return;
    const prop: Proposal = editedPayload ? { ...p, payload: { ...p.payload, ...editedPayload } } : p;
    let planId: string | undefined;
    if (d.plan) {
      const res = applyProposal(d.plan, prop, d.lib, d.ctx);
      if (res.settingsPatch) {
        if (res.settingsPatch.mode) await this.setMode(res.settingsPatch.mode);
        if (res.settingsPatch.sessionsPerWeek) {
          await this.repo.updateSettings({ sessionsPerWeek: res.settingsPatch.sessionsPerWeek });
          await this.generatePlan(res.reason);
        }
      } else if (res.plan !== d.plan) {
        const saved = await this.persistPlan(res.plan, res.reason, 'proposal', p.id);
        planId = saved.id;
      }
    } else if (p.kind === 'mode_change') {
      await this.setMode(p.payload.mode as TrainingMode);
    }
    await this.repo.save('proposals', { ...prop, status: editedPayload ? 'edited' : 'accepted', resolvedAt: nowISO(this.clock()), planVersionId: planId });
  }

  async rejectProposal(id: string): Promise<void> {
    const p = await this.repo.get('proposals', id);
    if (p) await this.repo.save('proposals', { ...p, status: 'rejected', resolvedAt: nowISO(this.clock()) });
  }

  /* ---------------- weekly review ---------------- */

  async weeklyReviewPreview(weekStart: ISODate) {
    const { data, d } = await this.derived();
    if (!d.plan) return null;
    const readiness = readinessSeries(data.checkins, data.sleep, d.settings, addDays(weekStart, 6), 21);
    return buildWeeklyReview({
      weekStart,
      plan: d.plan,
      loads: d.loads,
      sessions: data.sessions,
      readiness,
      pain: data.pain,
      benchmarks: data.benchmarks,
      library: d.lib,
      bodyMassKg: d.profile.bodyMassKg,
      coldStart: d.settings.coldStart,
      fingerStatusLowToday: d.readinessToday.fingerLow,
      recentFingerPainMax: d.fingerPainRecent,
      failedProgressions: countFailedProgressions(data.sessions, d.lib, addDays(weekStart, 6)),
    });
  }

  /** Save the review and its proposals (pending — user accepts / edits / rejects them). */
  async completeWeeklyReview(weekStart: ISODate): Promise<ProposalDraft[]> {
    const out = await this.weeklyReviewPreview(weekStart);
    if (!out) return [];
    const saved = await this.repo.saveMany('proposals', out.proposals.map((p) => ({ ...p, payload: { ...p.payload, key: `review:${weekStart}:${p.kind}` } })));
    const existing = (await this.repo.list('weeklyReviews')).find((w) => w.weekStart === weekStart);
    await this.repo.save('weeklyReviews', {
      ...(existing ?? {}),
      weekStart,
      summary: out.summary,
      proposalIds: saved.map((p) => p.id),
      completedAt: nowISO(this.clock()),
    });
    return out.proposals;
  }

  /* ---------------- data (JSON) ---------------- */

  async exportJSON(): Promise<string> {
    return JSON.stringify(await this.repo.exportSnapshot());
  }

  async importJSON(text: string, mode: 'merge' | 'replace') {
    return this.repo.importSnapshot(JSON.parse(text) as RawSnapshot, mode);
  }
}
