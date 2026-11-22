import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/data/storage';
import { Repo } from '../src/data/repo';
import { Services } from '../src/app/services';
import { derive } from '../src/app/derive';
import { buildColdStartSeed, SUGGESTED_COLD_START } from '../src/engine/coldStart';
import { allSessions } from '../src/engine/planOps';
import { analyseInjuries } from '../src/engine/injuryPatterns';
import { addDays } from '../src/lib/dates';
import { BENCHMARKS } from './fixtures';

function make(iso = '2026-11-23T08:00:00Z') {
  let now = new Date(iso);
  const repo = new Repo(new MemoryStorage(), () => now);
  const svc = new Services(repo, () => now);
  return { svc, repo, setNow: (s: string) => (now = new Date(s)) };
}

async function seeded() {
  const m = make();
  await m.svc.boot();
  await m.svc.updateSettings({ coldStart: buildColdStartSeed(SUGGESTED_COLD_START, '2026-11-23'), onboardingDone: true });
  for (const b of BENCHMARKS) await m.svc.saveBenchmark({ ...b, id: undefined, createdAt: undefined, updatedAt: undefined });
  return m;
}

describe('services end-to-end', () => {
  it('boot -> generate -> validate -> guided log marks done and proposes progression', async () => {
    const { svc, setNow } = await seeded();
    const plan = await svc.generatePlan();
    expect(plan.version).toBe(1);
    await svc.validateAllWeeks();
    let { d } = await svc.derived();
    expect(d.plan!.status).toBe('active');
    expect(d.plan!.version).toBe(2);
    const tue = allSessions(d.plan!).find((s) => s.date === '2026-11-24' && s.kind === 'training')!;
    const mh = tue.items.find((i) => i.exerciseId === 'max_hang_20_hc')!;
    setNow('2026-11-24T19:00:00Z');
    const log = await svc.saveSession({
      date: '2026-11-24', startedAt: null, kind: 'training', plannedSessionId: tue.id, durationMin: 85, sessionRPE: 7, location: 'gym', source: 'guided',
      globalLoad: 0, fingerLoad: 0, restrictedGripLoad: 0,
      sets: [0, 1, 2].map((i) => ({ id: `s${i}`, exerciseId: 'max_hang_20_hc', setIndex: i, completed: true, reps: 1, workS: 10, load: { ...mh.load }, rpe: 7, at: '2026-11-24T18:30:00Z' })),
    });
    expect(log.globalLoad).toBe(595);
    expect(log.fingerLoad > 0).toBe(true);
    ({ d } = await svc.derived());
    expect(allSessions(d.plan!).find((s) => s.id === tue.id)!.status).toBe('done');
    const prog = d.pending.filter((p) => p.kind === 'progression');
    expect(prog).toHaveLength(1);
    await svc.acceptProposal(prog[0].id);
    ({ d } = await svc.derived());
    const nextMh = allSessions(d.plan!).filter((s) => s.date > '2026-11-24').flatMap((s) => s.items).find((i) => i.exerciseId === 'max_hang_20_hc')!;
    expect(nextMh.load.value).toBe(prog[0].payload.value as number);
  });

  it('missed session -> proposal; rejecting it prevents re-proposal', async () => {
    const { svc, setNow } = await seeded();
    await svc.generatePlan();
    await svc.validateAllWeeks();
    setNow('2026-11-25T08:00:00Z');
    expect(await svc.refreshProposals()).toBeGreaterThan(0);
    let { d } = await svc.derived();
    const missed = d.pending.find((p) => String(p.payload.key).startsWith('missed:'))!;
    expect(['reschedule', 'drop'].includes(missed.kind)).toBe(true);
    await svc.rejectProposal(missed.id);
    await svc.refreshProposals();
    ({ d } = await svc.derived());
    expect(d.pending.some((p) => p.payload.key === missed.payload.key)).toBe(false);
  });

  it('newborn proposal from 1 March 2027; accepting switches mode and regenerates', async () => {
    const { svc, setNow } = await seeded();
    await svc.generatePlan();
    setNow('2027-03-01T08:00:00Z');
    await svc.refreshProposals();
    let { d } = await svc.derived();
    const p = d.pending.find((x) => x.kind === 'mode_change')!;
    await svc.acceptProposal(p.id);
    ({ d } = await svc.derived());
    expect(d.settings.mode).toBe('newborn');
    expect(d.plan!.macro[0].kind).toBe('newborn');
    await svc.setMode('normal');
    ({ d } = await svc.derived());
    expect(d.settings.mode).toBe('return_ramp');
    expect(d.plan!.macro[0].kind).toBe('return_ramp');
  });

  it('weekly review creates a stored review and keyed proposals', async () => {
    const { svc, setNow } = await seeded();
    await svc.generatePlan();
    await svc.validateAllWeeks();
    setNow('2026-11-29T18:00:00Z');
    await svc.completeWeeklyReview('2026-11-23');
    const { data, d } = await svc.derived();
    expect(data.weeklyReviews).toHaveLength(1);
    expect(d.reviewDone).toBe(true);
    expect(data.weeklyReviews[0].summary.adherencePct).toBe(0);
  });

  it('rebuilding a week with an outdoor day keeps rules', async () => {
    const { svc, repo } = await seeded();
    const plan = await svc.generatePlan();
    const w = plan.weeks[1];
    await repo.save('plans', { ...plan, weeks: plan.weeks.map((x) => (x.id === w.id ? { ...x, outdoorDays: [addDays(w.startDate, 6)] } : x)) });
    const p2 = await svc.rebuildWeek(w.id);
    const wk = p2.weeks.find((x) => x.id === w.id)!;
    expect(wk.sessions.some((s) => s.location === 'outdoor' && s.date === addDays(w.startDate, 6))).toBe(true);
  });

  it('derive() works on an empty database', async () => {
    const { svc } = make();
    const data = await svc.loadAll();
    const d = derive(data, '2026-11-23');
    expect(d.global.zone).toBe('none');
    expect(d.plan).toBeUndefined();
  });
});

describe('what preceded my injuries', () => {
  it('flags a finger-load spike before an episode and lists recurring patterns', () => {
    const loads = [];
    for (let w = 0; w < 16; w++) for (const dd of [1, 3, 5]) {
      const date = addDays('2026-06-01', w * 7 + dd);
      const spike = w === 6 || w === 13;
      loads.push({ date, globalLoad: 600, fingerLoad: spike ? 110 : 55, restrictedGripLoad: spike ? 40 : 3 });
    }
    const inj = (start: string) => ({
      id: start, createdAt: '', updatedAt: '', start, end: addDays(start, 21), cause: 'crimp', status: 'resolved' as const,
      location: { region: 'finger' as const, side: 'right' as const, finger: 'ring' as const, structure: 'A2' as const },
    });
    const r = analyseInjuries([inj('2026-07-20'), inj('2026-09-07')], loads, [], null, '2026-10-01');
    expect(r.episodes).toHaveLength(2);
    expect(r.episodes[0].flags.some((f) => f.includes('jump'))).toBe(true);
    expect(r.recurring.length > 0).toBe(true);
  });
});
