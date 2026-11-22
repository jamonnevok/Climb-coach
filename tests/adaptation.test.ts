import { describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates';
import {
  applyProposal,
  detectMissed,
  evaluateDeloadTriggers,
  proposeDeload,
  proposeForMissed,
  proposeForPain,
  proposeForReadiness,
  proposeModeChange,
  nextModeOnDeactivate,
  type DeloadSignals,
} from '../src/engine/adaptation';
import { computeACWR } from '../src/engine/load';
import { generatePlan } from '../src/engine/planGenerator';
import { checkRules } from '../src/engine/planRules';
import { allSessions, moveSession, recordVersion, validateWeek } from '../src/engine/planOps';
import { evaluatePain } from '../src/engine/pain';
import type { PainEntry } from '../src/data/schema';
import type { ReadinessResult } from '../src/engine/readiness';
import { genInput, settings } from './fixtures';

const inp = genInput();
const plan = generatePlan(inp);
const main = (d: string) => allSessions(plan).find((s) => s.date === d && s.kind !== 'prehab')!;

const rd = (date: string, advice: ReadinessResult['advice'], sleepBelow = false): ReadinessResult => ({
  date, score: advice === 'proceed' ? 80 : advice === 'lighter' ? 55 : 30, advice, fingerLow: false, sleepH: sleepBelow ? 5.5 : 7.5,
  sleepBaselineH: 7.5, sleepBelowBaseline: sleepBelow, components: {}, reasons: ['test'],
});

describe('missed sessions', () => {
  it('detects planned sessions in the past', () => {
    expect(detectMissed(plan, '2026-11-26').map((s) => s.date)).toContain('2026-11-24');
  });

  it('reschedules within the week when safe, never stacking', () => {
    const tue = main('2026-11-24');
    const p = proposeForMissed(plan, tue.id, '2026-11-24')!;
    expect(p.kind).toBe('reschedule');
    const to = p.payload.toDate as string;
    expect(to > '2026-11-24' && to <= '2026-11-29').toBe(true);
    const applied = applyProposal(plan, p, inp.library, inp.ctx);
    expect(checkRules(allSessions(applied.plan))).toEqual([]);
  });

  it('drops when no safe day is left', () => {
    const sat = main('2026-11-28');
    const p = proposeForMissed(plan, sat.id, '2026-11-29')!;
    expect(p.kind).toBe('drop');
    const applied = applyProposal(plan, p, inp.library, inp.ctx);
    expect(allSessions(applied.plan).find((s) => s.id === sat.id)!.status).toBe('dropped');
  });
});

describe('early deload triggers', () => {
  const calm = computeACWR([], { metric: 'finger', asOf: '2026-11-26', coldStart: settings().coldStart });
  const base: DeloadSignals = { fingerAcwr: calm, fingerWeekOnWeek: null, readiness: [], pain: [], failedProgressions: 0, asOf: '2026-11-26' };

  it('one trigger alone does not propose', () => {
    const r = evaluateDeloadTriggers({ ...base, failedProgressions: 2 });
    expect(r.triggers).toHaveLength(1);
    expect(r.propose).toBe(false);
  });

  it('two triggers (low readiness 3 days + poor sleep 3 nights) propose a deload', () => {
    const readiness = ['2026-11-24', '2026-11-25', '2026-11-26'].map((d) => rd(d, 'lighter', true));
    const r = evaluateDeloadTriggers({ ...base, readiness });
    expect(r.propose).toBe(true);
    const p = proposeDeload(plan, '2026-11-26', r.triggers)!;
    expect(p.payload.weekStart).toBe('2026-11-23');
    const applied = applyProposal(plan, p, inp.library, inp.ctx);
    const wk = applied.plan.weeks[0];
    expect(wk.isDeload).toBe(true);
    const before = plan.weeks[0].sessions.filter((s) => s.date >= '2026-11-26').reduce((a, s) => a + s.estFingerLoad, 0);
    const after = wk.sessions.filter((s) => s.date >= '2026-11-26').reduce((a, s) => a + s.estFingerLoad, 0);
    expect(after < before).toBe(true);
    // earlier sessions untouched
    expect(wk.sessions.find((s) => s.date === '2026-11-24')!.title.includes('deload')).toBe(false);
  });

  it('rising finger pain counts as a trigger', () => {
    const pe = (date: string, pain: number): PainEntry => ({
      id: date + pain, createdAt: '', updatedAt: '', date, at: `${date}T18:00:00Z`, moment: 'during', pain, redFlags: [],
      location: { region: 'finger', side: 'right', finger: 'middle', structure: 'A2' },
    });
    const pain = [pe('2026-11-24', 2), pe('2026-11-25', 3), pe('2026-11-26', 4)];
    const r = evaluateDeloadTriggers({ ...base, pain, failedProgressions: 2 });
    expect(r.triggers.some((t) => t.includes('pain'))).toBe(true);
    expect(r.propose).toBe(true);
  });
});

describe('readiness proposals', () => {
  it('rest / lighter / finger downgrade', () => {
    const tue = '2026-11-24';
    expect(proposeForReadiness(plan, tue, rd(tue, 'rest'))!.payload.variant).toBe('rest');
    expect(proposeForReadiness(plan, tue, rd(tue, 'lighter'))!.payload.variant).toBe('lighter');
    const fl = proposeForReadiness(plan, tue, { ...rd(tue, 'proceed'), fingerLow: true })!;
    expect(fl.payload.variant).toBe('finger_downgrade');
    const applied = applyProposal(plan, fl, inp.library, inp.ctx);
    const s = allSessions(applied.plan).find((x) => x.id === fl.payload.sessionId)!;
    expect(s.items.some((i) => i.exerciseId === 'max_hang_20_hc')).toBe(false);
    expect(s.items.some((i) => i.exerciseId === 'tendon_iso_low')).toBe(true);
  });
  it('no proposal when ready', () => {
    expect(proposeForReadiness(plan, '2026-11-24', rd('2026-11-24', 'proceed'))).toBeNull();
  });
});

describe('pain proposals', () => {
  const pe = (date: string, pain: number, moment: PainEntry['moment'] = 'during', redFlags: PainEntry['redFlags'] = []): PainEntry => ({
    id: `${date}${moment}${pain}`, createdAt: '', updatedAt: '', date, at: `${date}T${moment === 'next_morning' ? '07' : '19'}:00:00Z`, moment, pain, redFlags,
    location: { region: 'finger', side: 'right', finger: 'ring', structure: 'A2' }, aggravatingGrip: 'full_crimp',
  });
  it('traffic light', () => {
    expect(evaluatePain([pe('2026-11-24', 2)], '2026-11-24')[0].light).toBe('green');
    expect(evaluatePain([pe('2026-11-24', 4)], '2026-11-24')[0].light).toBe('amber');
    expect(evaluatePain([pe('2026-11-24', 6)], '2026-11-24')[0].light).toBe('red');
    expect(evaluatePain([pe('2026-11-23', 1, 'next_morning'), pe('2026-11-24', 2, 'next_morning')], '2026-11-24')[0].light).toBe('red');
    expect(evaluatePain([pe('2026-11-24', 2, 'during', ['audible_pop'])], '2026-11-24')[0].light).toBe('red_flag');
  });
  it('no improvement after 2 weeks becomes a red flag', () => {
    const entries = [pe('2026-11-08', 4), pe('2026-11-15', 4), pe('2026-11-23', 4)];
    const ev = evaluatePain(entries, '2026-11-23')[0];
    expect(ev.redFlags).toContain('no_improvement_2w');
  });
  it('amber -> modify (aggravating grip removed), red flag -> see a physio', () => {
    const amber = proposeForPain(plan, evaluatePain([pe('2026-11-23', 4)], '2026-11-23'), '2026-11-23');
    expect(amber[0].kind).toBe('pain_modify');
    expect(amber[0].payload.removeGrips).toEqual(['full_crimp']);
    const flag = proposeForPain(plan, evaluatePain([pe('2026-11-23', 3, 'during', ['swelling'])], '2026-11-23'), '2026-11-23');
    expect(flag[0].kind).toBe('pain_stop');
    expect(flag[0].payload.seePhysio).toBe(true);
    expect(flag[0].payload.protocolId).toBe('pulley_strain');
    const applied = applyProposal(plan, flag[0], inp.library, inp.ctx);
    const hard = allSessions(applied.plan).filter((s) => s.date >= '2026-11-23' && s.date <= '2026-11-29' && s.kind !== 'test')
      .flatMap((s) => s.items).filter((i) => i.exerciseId === 'max_hang_20_hc');
    expect(hard).toHaveLength(0);
  });
});

describe('modes, plan ops & versioning', () => {
  it('suggests newborn mode from the preset date, return ramp when leaving', () => {
    expect(proposeModeChange(settings(), '2027-02-20')).toBeNull();
    const p = proposeModeChange(settings(), '2027-03-01')!;
    expect(p.payload.mode).toBe('newborn');
    expect(applyProposal(plan, p, inp.library, inp.ctx).settingsPatch).toEqual({ mode: 'newborn' });
    expect(nextModeOnDeactivate('newborn')).toBe('return_ramp');
  });

  it('drag & drop reports rule violations without blocking', () => {
    const tue = main('2026-11-24');
    const sat = main('2026-11-28');
    const r = moveSession(plan, sat.id, addDays(tue.date, 1));
    expect(r.violations.some((v) => v.rule === 'back_to_back_high')).toBe(true);
    expect(r.plan.weeks[0].validated).toBe(false);
  });

  it('validate + record version snapshot', () => {
    const v = validateWeek(plan, plan.weeks[0].id);
    expect(v.weeks[0].validated).toBe(true);
    expect(v.status).toBe('active');
    const { plan: bumped, version } = recordVersion(v, 'Validated week 1', 'user', undefined, '2026-11-23');
    expect(bumped.version).toBe(plan.version + 1);
    expect(version.snapshot.version).toBe(bumped.version);
    expect(version.reason).toBe('Validated week 1');
  });
});
