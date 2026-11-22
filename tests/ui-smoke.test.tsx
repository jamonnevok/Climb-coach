/**
 * UI smoke test: every page renders (server-side) on an empty and on a seeded database.
 * Catches runtime errors in render paths without a browser.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryStorage } from '../src/data/storage';
import { Repo } from '../src/data/repo';
import { Services } from '../src/app/services';
import { StoreProvider } from '../src/ui/store';
import { App } from '../src/ui/App';
import { TodayPage } from '../src/ui/pages/Today';
import { PlanPage } from '../src/ui/pages/Plan';
import { SessionPage } from '../src/ui/pages/Session';
import { LogPage } from '../src/ui/pages/Log';
import { StatsPage } from '../src/ui/pages/Stats';
import { BodyPage } from '../src/ui/pages/Body';
import { SettingsPage } from '../src/ui/pages/Settings';
import { OnboardingPage } from '../src/ui/pages/Onboarding';
import { buildColdStartSeed, SUGGESTED_COLD_START } from '../src/engine/coldStart';
import { allSessions } from '../src/engine/planOps';
import { BENCHMARKS } from './fixtures';

const now = new Date('2026-11-24T08:00:00Z');

function pages(extra: [string, JSX.Element][] = []): [string, JSX.Element][] {
  return [
    ['today', <TodayPage />],
    ['plan', <PlanPage />],
    ['session', <SessionPage parts={['session']} />],
    ['log', <LogPage parts={['log']} />],
    ['stats', <StatsPage />],
    ['body', <BodyPage parts={['body']} />],
    ['settings', <SettingsPage />],
    ['onboarding', <OnboardingPage />],
    ['app', <App />],
    ...extra,
  ];
}

describe('UI smoke', () => {
  it('renders every page on empty and seeded data', async () => {
    const svc = new Services(new Repo(new MemoryStorage(), () => now), () => now);
    await svc.boot();
    let init = await svc.derived();
    for (const [, el] of pages()) expect(renderToString(<StoreProvider svc={svc} initial={init}>{el}</StoreProvider>).length > 0).toBe(true);

    await svc.updateSettings({ coldStart: buildColdStartSeed(SUGGESTED_COLD_START, '2026-11-01'), onboardingDone: true });
    for (const b of BENCHMARKS) await svc.saveBenchmark({ ...b, id: undefined, createdAt: undefined, updatedAt: undefined });
    await svc.generatePlan();
    await svc.validateAllWeeks();
    await svc.saveCheckin({ date: '2026-11-24', sleepQuality: 3, fatigue: 2, soreness: 3, stress: 3, motivation: 4, fingerStatus: 2 });
    await svc.savePain({ date: '2026-11-24', at: '2026-11-24T07:00:00Z', location: { region: 'finger', side: 'right', finger: 'ring', structure: 'A2' }, moment: 'next_morning', pain: 4, redFlags: [] });
    await svc.saveInjury({ start: '2026-10-01', end: null, location: { region: 'finger', side: 'right', finger: 'ring', structure: 'A2' }, cause: 'crimp', status: 'active', protocolId: 'pulley_strain', protocolStage: 2 });
    await svc.refreshProposals();
    init = await svc.derived();
    expect(init.d.pending.some((p) => p.title.startsWith('Drop "Finger prehab'))).toBe(false); // pre-start days skipped, not missed
    const tue = allSessions(init.d.plan!).find((s) => s.date === '2026-11-24' && s.kind !== 'prehab')!;
    const all = pages([
      ['runner', <SessionPage parts={['session', tue.id]} />],
      ['test', <SessionPage parts={['session', 'test', 'test_peak_force']} />],
    ]);
    for (const [, el] of all) expect(renderToString(<StoreProvider svc={svc} initial={init}>{el}</StoreProvider>).length > 0).toBe(true);
    expect(renderToString(<StoreProvider svc={svc} initial={init}><TodayPage /></StoreProvider>).includes('Proposals')).toBe(true);
  });
});
