/**
 * BODY: body map (fingers × A2/A3/A4, wrist, elbow, shoulder, skin), pain traffic light,
 * injury episodes with generic return-to-climbing protocols (medical disclaimer),
 * and "what preceded my injuries".
 */
import { useMemo, useState } from 'react';
import { rehab } from '../../config';
import type { BodyLocation, InjuryEpisode, PainMoment } from '../../data/schema';
import { addDays, diffDays } from '../../lib/dates';
import { analyseInjuries } from '../../engine/injuryPatterns';
import { locationKey, locationLabel, protocolFor } from '../../engine/pain';
import { readinessSeries } from '../../engine/readiness';
import { useStore } from '../store';
import { PAIN_STYLE, fmtDate, fmtNum } from '../format';
import { Badge, Button, Card, Disclaimer, Empty, Field, ReferenceList, Section, Sheet, confirmAction } from '../components/ui';
import { BodyMap } from '../components/bodyParts';
import { PainSheet } from '../components/forms';

function InjurySheet({ open, onClose, location, existing }: { open: boolean; onClose: () => void; location: BodyLocation | null; existing?: InjuryEpisode }) {
  const { svc, run, d } = useStore();
  const [start, setStart] = useState(existing?.start ?? d.today);
  const [cause, setCause] = useState(existing?.cause ?? '');
  const [diagnosis, setDiagnosis] = useState(existing?.diagnosis ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const loc = existing?.location ?? location;
  if (!loc) return null;
  return (
    <Sheet open={open} onClose={onClose} title={existing ? 'Edit injury' : `New injury — ${locationLabel(loc)}`}>
      <div className="space-y-4">
        <Field label="Start">
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Cause / situation">
          <input value={cause} onChange={(e) => setCause(e.target.value)} placeholder="e.g. full crimp on a pocket, cold fingers" />
        </Field>
        <Field label="Diagnosis (from a professional, optional)">
          <input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} />
        </Field>
        <Field label="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button
          className="w-full"
          onClick={() =>
            void run(async () => {
              await svc.saveInjury({
                ...(existing ?? {}),
                start,
                end: existing?.end ?? null,
                location: loc,
                cause,
                diagnosis: diagnosis || undefined,
                notes: notes || undefined,
                status: existing?.status ?? 'active',
                protocolId: existing?.protocolId ?? protocolFor(loc) ?? undefined,
                protocolStage: existing?.protocolStage ?? 1,
              });
              onClose();
            }, 'Injury saved')
          }
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}

function RehabCard({ inj }: { inj: InjuryEpisode }) {
  const { svc, run, d } = useStore();
  const proto = inj.protocolId ? rehab.protocols[inj.protocolId] : undefined;
  const stage = inj.protocolStage ?? 1;
  const ev = d.painEvals.find((e) => e.key === locationKey(inj.location));
  const st = proto?.stages.find((s) => s.stage === stage);
  const daysIn = diffDays(inj.start, d.today);
  const canAdvance = !ev || ev.light === 'green';
  return (
    <Card className="space-y-3">
      <div className="flex justify-between gap-2">
        <div>
          <div className="font-semibold">{locationLabel(inj.location)}</div>
          <div className="text-xs text-muted">
            since {fmtDate(inj.start)} · day {daysIn}
            {inj.diagnosis ? ` · ${inj.diagnosis}` : ''}
          </div>
        </div>
        {ev && <Badge cls={PAIN_STYLE[ev.light].cls}>{PAIN_STYLE[ev.light].label}</Badge>}
      </div>
      {proto && st && (
        <div className="space-y-2">
          <div className="text-sm">
            <b>
              Stage {stage}/{proto.stages.length}: {st.title}
            </b>{' '}
            <span className="text-muted">(min {st.minDays} days)</span>
          </div>
          <ul className="list-disc pl-5 text-sm space-y-0.5">
            {st.content.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <ReferenceList ids={proto.references} />
          <div className="flex gap-2">
            {stage > 1 && (
              <Button small tone="ghost" onClick={() => void run(() => svc.saveInjury({ ...inj, protocolStage: stage - 1 }), 'Back one stage')}>
                ‹ Stage back
              </Button>
            )}
            {stage < proto.stages.length && (
              <Button small disabled={!canAdvance} onClick={() => void run(() => svc.saveInjury({ ...inj, protocolStage: stage + 1 }), 'Next stage')}>
                Next stage ›
              </Button>
            )}
          </div>
          {!canAdvance && <p className="text-xs text-warn">Advance only when pain is ≤ 2/10 during and not worse next morning.</p>}
        </div>
      )}
      <div className="flex gap-2">
        <Button small tone="ghost" onClick={() => confirmAction('Mark this injury as resolved today?') && void run(() => svc.saveInjury({ ...inj, end: d.today, status: 'resolved' }), 'Injury resolved')}>
          Mark resolved
        </Button>
      </div>
    </Card>
  );
}

export function BodyPage({ parts }: { parts: string[] }) {
  const { d, data } = useStore();
  const [sel, setSel] = useState<BodyLocation | null>(null);
  const [pain, setPain] = useState(false);
  const [injury, setInjury] = useState(false);
  const moment: PainMoment = parts[1] === 'cooldown' ? 'cooldown' : 'during';
  const active = data.injuries.filter((i) => i.status === 'active');
  const resolved = data.injuries.filter((i) => i.status === 'resolved').sort((a, b) => b.start.localeCompare(a.start));
  const history = [...data.pain].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);

  const report = useMemo(() => {
    if (!data.injuries.length) return null;
    const first = data.injuries.reduce((m, i) => (i.start < m ? i.start : m), d.today);
    const days = Math.max(28, diffDays(addDays(first, -35), d.today) + 1);
    const rd = readinessSeries(data.checkins, data.sleep, d.settings, d.today, Math.min(days, 730));
    return analyseInjuries(data.injuries, d.loads, rd, d.settings.coldStart, d.today);
  }, [data.injuries, data.checkins, data.sleep, d.loads, d.settings, d.today]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Body</h1>
      <Card className="space-y-3">
        <p className="text-sm text-muted">Tap where it hurts{moment === 'cooldown' ? ' (cool-down)' : ''}. Colours show today’s traffic light.</p>
        <BodyMap evals={d.painEvals} selected={sel ? locationKey(sel) : null} onPick={(l) => { setSel(l); setPain(true); }} />
        {sel && (
          <div className="flex gap-2">
            <Button small onClick={() => setPain(true)}>
              Log pain — {locationLabel(sel)}
            </Button>
            <Button small tone="ghost" onClick={() => setInjury(true)}>
              Start injury episode
            </Button>
          </div>
        )}
      </Card>

      <Disclaimer>
        Traffic light: ≤ 2/10 and not worse next morning = continue · 3-5 = modify · &gt; 5 or worsening = stop. <b>Stop and see a physio</b> if you notice an audible pop, bowstringing, swelling, pain at rest above 3/10, or no improvement after 2 weeks. {rehab.disclaimer}
      </Disclaimer>

      {d.painEvals.length > 0 && (
        <Section title="Current status (last 3 days)">
          <div className="space-y-2">
            {d.painEvals.map((e) => (
              <Card key={e.key} className="flex justify-between items-center gap-2">
                <div>
                  <div className="font-medium">{locationLabel(e.location)}</div>
                  <div className="text-xs text-muted">{e.reasons.join(' ') || `max ${e.maxPain}/10`}</div>
                </div>
                <Badge cls={PAIN_STYLE[e.light].cls}>{PAIN_STYLE[e.light].label}</Badge>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <Section title="Active injuries">
        {active.length ? <div className="space-y-3">{active.map((i) => <RehabCard key={i.id} inj={i} />)}</div> : <Empty>None. Keep it that way: warm up, respect the caps.</Empty>}
      </Section>

      <Section title="What preceded my injuries">
        {!report || !report.episodes.length ? (
          <Empty>Record injury episodes to see the 2-4 weeks before each one.</Empty>
        ) : (
          <Card className="space-y-3">
            {report.recurring.length > 0 && (
              <div>
                <div className="text-sm font-semibold">Recurring before ≥ 2 episodes</div>
                <ul className="list-disc pl-5 text-sm">
                  {report.recurring.map((r) => (
                    <li key={r.flag}>
                      {r.flag} ({r.count}×)
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.typical && (
              <div className="text-xs text-muted">
                Your typical week: {fmtNum(report.typical.fingerLoadPerWeek, 0)} FLU · restricted {report.typical.restrictedSharePct} % · readiness {fmtNum(report.typical.avgReadiness, 0)} · sleep {fmtNum(report.typical.avgSleepH, 1)} h
              </div>
            )}
            {report.episodes.map((e) => (
              <div key={e.injury.id} className="border-t border-line pt-2 text-sm">
                <div className="font-medium">{e.label}</div>
                <div className="text-xs text-muted">
                  4 wk before: {fmtNum(e.w4.fingerLoadPerWeek, 0)} FLU/wk · ACWR peak {fmtNum(e.w4.fingerAcwrPeak, 2)} · max jump {fmtNum(e.w4.maxFingerWeekJumpPct, 0)} % · restricted {e.w4.restrictedSharePct} % · short nights {e.w2.nightsBelowBaseline} (2 wk)
                </div>
                {e.flags.length ? (
                  <ul className="list-disc pl-5">
                    {e.flags.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-xs text-muted">No unusual pattern detected.</div>
                )}
              </div>
            ))}
            <p className="text-xs text-muted">{report.note}</p>
          </Card>
        )}
      </Section>

      {resolved.length > 0 && (
        <Section title="Past injuries">
          <div className="space-y-2">
            {resolved.map((i) => (
              <Card key={i.id} className="text-sm flex justify-between">
                <span>{locationLabel(i.location)}</span>
                <span className="text-muted">
                  {fmtDate(i.start)} → {i.end ? fmtDate(i.end) : '…'}
                </span>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <Section title="Pain log">
        {history.length ? (
          <Card className="space-y-1 text-sm">
            {history.map((p) => (
              <div key={p.id} className="flex justify-between gap-2">
                <span>
                  {fmtDate(p.date)} · {locationLabel(p.location)} · {p.moment.replace('_', ' ')}
                </span>
                <span className={p.pain > 5 ? 'text-bad' : p.pain > 2 ? 'text-warn' : 'text-muted'}>
                  {p.pain}/10{p.redFlags.length ? ' ⚑' : ''}
                </span>
              </div>
            ))}
          </Card>
        ) : (
          <Empty>No pain recorded.</Empty>
        )}
      </Section>

      <PainSheet open={pain} location={sel} onClose={() => setPain(false)} initialMoment={moment} key={(sel ? locationKey(sel) : '') + moment} />
      {injury && <InjurySheet open location={sel} onClose={() => setInjury(false)} />}
    </div>
  );
}
