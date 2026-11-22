/**
 * Daily proposal refresh: gathers every adaptation rule into deduplicated proposal drafts.
 * A proposal is identified by payload.key; once a key exists (in ANY status), it is not
 * proposed again — so rejecting something means it stays rejected.
 */
import { addDays, startOfWeek } from '../lib/dates';
import type { Proposal } from '../data/schema';
import {
  detectMissed,
  evaluateDeloadTriggers,
  proposeDeload,
  proposeForMissed,
  proposeForPain,
  proposeForReadiness,
  proposeModeChange,
  type ProposalDraft,
} from '../engine/adaptation';
import { countFailedProgressions } from '../engine/weeklyReview';
import type { AppData, Derived } from './derive';

function keyed(p: ProposalDraft | null, key: string): ProposalDraft | null {
  return p ? { ...p, payload: { ...p.payload, key } } : null;
}

export function computeProposals(data: AppData, d: Derived): ProposalDraft[] {
  const out: (ProposalDraft | null)[] = [];
  const plan = d.plan;
  if (plan && plan.status === 'active') {
    for (const s of detectMissed(plan, d.today)) {
      out.push(keyed(proposeForMissed(plan, s.id, d.today, d.settings.unavailableWeekdays), `missed:${s.id}`));
    }
    const rd = d.readinessToday;
    const r = proposeForReadiness(plan, d.today, rd);
    if (r) out.push(keyed(r, `readiness:${d.today}:${String(r.payload.sessionId)}:${String(r.payload.variant)}`));
    const painDrafts = proposeForPain(plan, d.painEvals.filter((e) => e.light !== 'green'), d.today);
    painDrafts.forEach((p) => out.push(keyed(p, `pain:${d.today}:${String(p.payload.locationKey)}:${p.kind}`)));
    const failed = countFailedProgressions(data.sessions, d.lib, d.today);
    const dl = evaluateDeloadTriggers({ fingerAcwr: d.finger, fingerWeekOnWeek: d.wow, readiness: d.readiness, pain: data.pain, failedProgressions: failed, asOf: d.today });
    if (dl.propose) {
      const p = proposeDeload(plan, d.today, dl.triggers);
      if (p) out.push(keyed(p, `deload:${String(p.payload.weekStart)}`));
    }
  } else if (!plan) {
    // Pain red flags are shown even without a plan.
    for (const e of d.painEvals.filter((x) => x.light === 'red_flag')) {
      out.push({
        id: `flag-${e.key}-${d.today}`,
        kind: 'pain_stop',
        status: 'pending',
        title: 'Stop and see a physio',
        reason: e.reasons.join(' '),
        triggers: ['pain', ...e.redFlags],
        payload: { key: `pain:${d.today}:${e.key}:pain_stop`, sessionIds: [], seePhysio: true },
        expiresOn: null,
        resolvedAt: null,
      });
    }
  }
  out.push(keyed(proposeModeChange(d.settings, d.today), `mode:newborn:${d.settings.newbornSuggestFrom ?? ''}`));
  const existing = new Set(data.proposals.map((p) => (p.payload as { key?: string }).key).filter(Boolean));
  const seen = new Set<string>();
  return out.filter((p): p is ProposalDraft => {
    if (!p) return false;
    const k = (p.payload as { key: string }).key;
    if (existing.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Pending proposals whose expiry date has passed. */
export function expiredProposals(data: AppData, today: string): Proposal[] {
  return data.proposals.filter((p) => !p.deleted && p.status === 'pending' && p.expiresOn !== null && p.expiresOn < today);
}

/** Monday of the week the Sunday review covers (the current week on Sunday). */
export function reviewWeekFor(today: string): string {
  const ws = startOfWeek(today);
  return new Date(today + 'T12:00:00').getDay() === 0 ? ws : addDays(ws, -7);
}
