/** LOG: sessions (with climbs), climbs, wellness (check-ins & sleep), benchmarks. */
import { useState } from 'react';
import type { BenchmarkType, SessionLog } from '../../data/schema';
import { navigate } from '../router';
import { useStore } from '../store';
import { SESSION_KIND_LABELS, fmtDate, fmtLoad, fmtNum } from '../format';
import { Badge, Button, Card, Empty, Section, Segmented, confirmAction } from '../components/ui';
import { BENCHMARK_META, BenchmarkSheet, CheckinSheet, ClimbSheet, QuickLogSheet, SleepSheet } from '../components/forms';
import { estimate1RMAdded } from '../../engine/assessment';

type Tab = 'sessions' | 'climbs' | 'wellness' | 'benchmarks';

function SessionRow({ s }: { s: SessionLog }) {
  const { data, d, svc, run } = useStore();
  const [open, setOpen] = useState(false);
  const [climb, setClimb] = useState(false);
  const climbs = data.climbs.filter((c) => c.sessionLogId === s.id);
  return (
    <Card className="space-y-2">
      <button className="w-full text-left" onClick={() => setOpen(!open)}>
        <div className="flex justify-between gap-2">
          <span className="font-medium">
            {SESSION_KIND_LABELS[s.kind]}
            {s.otherSportName ? ` · ${s.otherSportName}` : ''}
          </span>
          <span className="text-sm text-muted">{fmtDate(s.date)}</span>
        </div>
        <div className="text-xs text-muted">
          {s.durationMin} min · sRPE {s.sessionRPE} · {s.globalLoad} AU · finger {fmtNum(s.fingerLoad, 0)} FLU
          {s.restrictedGripLoad > 0 ? ` (${fmtNum(s.restrictedGripLoad, 0)} restricted)` : ''}
          {climbs.length ? ` · ${climbs.length} climbs` : ''}
        </div>
      </button>
      {open && (
        <div className="space-y-2 text-sm">
          {s.sets.length > 0 && (
            <ul className="space-y-0.5">
              {s.sets.map((x) => (
                <li key={x.id} className="flex justify-between gap-2">
                  <span>
                    {d.lib.get(x.exerciseId)?.name ?? x.exerciseId} #{x.setIndex + 1}
                    {x.hand && x.hand !== 'both' ? ` (${x.hand})` : ''}
                  </span>
                  <span className={x.completed ? 'text-muted' : 'text-bad'}>
                    {x.reps}×{x.workS ? `${x.workS}s` : ''} {fmtLoad(x.load.mode, x.load.value)}
                    {x.rpe !== undefined ? ` · RPE ${x.rpe}` : ''}
                    {x.peakForceKg ? ` · ${x.peakForceKg} kg` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {climbs.map((c) => (
            <div key={c.id} className="flex justify-between">
              <span>
                {c.grade} {c.style} {c.name ? `· ${c.name}` : ''}
              </span>
              <span className="text-muted">
                {c.attempts} {c.discipline === 'route' ? 'burns' : 'tries'} · {c.setting}
              </span>
            </div>
          ))}
          {s.notes && <p className="text-muted">{s.notes}</p>}
          <div className="flex gap-2">
            <Button small tone="ghost" onClick={() => setClimb(true)}>
              Add climb
            </Button>
            <Button small tone="ghost" onClick={() => confirmAction('Delete this session?') && void run(() => svc.softDelete('sessions', s.id), 'Deleted')}>
              Delete
            </Button>
          </div>
        </div>
      )}
      {climb && <ClimbSheet open onClose={() => setClimb(false)} sessionLogId={s.id} date={s.date} />}
    </Card>
  );
}

export function LogPage({ parts }: { parts: string[] }) {
  const { data, d, svc, run } = useStore();
  const [tab, setTab] = useState<Tab>((parts[1] as Tab) ?? 'sessions');
  const [quick, setQuick] = useState(false);
  const [climb, setClimb] = useState(false);
  const [checkin, setCheckin] = useState(false);
  const [sleep, setSleep] = useState(false);
  const [bench, setBench] = useState<BenchmarkType | null>(null);
  const sessions = [...data.sessions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const climbs = [...data.climbs].sort((a, b) => b.date.localeCompare(a.date));
  const bm = d.profile.bodyMassKg;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Log</h1>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'sessions', label: 'Sessions' },
          { value: 'climbs', label: 'Climbs' },
          { value: 'wellness', label: 'Wellness' },
          { value: 'benchmarks', label: 'Tests' },
        ]}
      />

      {tab === 'sessions' && (
        <div className="space-y-3">
          <Button className="w-full" onClick={() => setQuick(true)}>
            Quick log (unplanned / other sport)
          </Button>
          {sessions.length ? sessions.slice(0, 60).map((s) => <SessionRow key={s.id} s={s} />) : <Empty>No sessions yet.</Empty>}
        </div>
      )}

      {tab === 'climbs' && (
        <div className="space-y-3">
          <Button className="w-full" onClick={() => setClimb(true)}>
            Add climb
          </Button>
          {climbs.length ? (
            climbs.slice(0, 100).map((c) => (
              <Card key={c.id} className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {c.grade} · {c.style}
                    {c.name ? ` · ${c.name}` : ''}
                  </div>
                  <div className="text-xs text-muted">
                    {fmtDate(c.date)} · {c.setting}
                    {c.board ? ` (${c.board}${c.boardAngleDeg ? ` ${c.boardAngleDeg}°` : ''})` : ''} · {c.angle.replace('_', ' ')} · {c.attempts} {c.discipline === 'route' ? 'burns' : 'tries'}
                  </div>
                </div>
                <button className="text-xs text-bad" onClick={() => confirmAction('Delete climb?') && void run(() => svc.deleteClimb(c), 'Deleted')}>
                  delete
                </button>
              </Card>
            ))
          ) : (
            <Empty>No climbs yet.</Empty>
          )}
        </div>
      )}

      {tab === 'wellness' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setCheckin(true)}>Today's check-in</Button>
            <Button tone="ghost" onClick={() => setSleep(true)}>
              Add sleep
            </Button>
          </div>
          {d.readiness
            .slice()
            .reverse()
            .filter((r) => r.score !== null || r.sleepH !== null)
            .slice(0, 28)
            .map((r) => (
              <Card key={r.date} className="flex justify-between text-sm">
                <span>{fmtDate(r.date)}</span>
                <span className="text-muted">
                  {r.sleepH !== null ? `${r.sleepH} h` : '—'} · readiness {r.score ?? '—'}
                  {r.fingerLow ? ' · fingers low' : ''}
                </span>
              </Card>
            ))}
        </div>
      )}

      {tab === 'benchmarks' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setBench('max_hang_20mm_10s_hc')}>Add result</Button>
            <Button tone="ghost" onClick={() => navigate('session')}>
              Run a test
            </Button>
          </div>
          {(Object.keys(BENCHMARK_META) as BenchmarkType[]).map((t) => {
            const hist = data.benchmarks.filter((b) => b.type === t).sort((a, b) => b.date.localeCompare(a.date));
            return (
              <Section key={t} title={BENCHMARK_META[t].label} action={<button className="text-sm text-accent" onClick={() => setBench(t)}>+ add</button>}>
                {hist.length ? (
                  <Card className="space-y-1 text-sm">
                    {hist.slice(0, 6).map((b) => (
                      <div key={b.id} className="flex justify-between gap-2">
                        <span>
                          {fmtDate(b.date)}
                          {b.hand && b.hand !== 'both' ? ` · ${b.hand}` : ''}
                          {b.source === 'tindeq' && <Badge cls="ml-1 bg-accent/15 text-accent">Tindeq</Badge>}
                        </span>
                        <span className="tabular">
                          {t === 'power_board_max_move'
                            ? b.gradeText
                            : t === 'max_hang_20mm_10s_hc'
                              ? `${b.value >= 0 ? '+' : ''}${b.value} kg · ${Math.round(((b.bodyMassKg + b.value) / b.bodyMassKg) * 100)} % BW`
                              : t === 'weighted_pullup'
                                ? `+${b.value} kg × ${b.reps ?? 1} (1RM ≈ +${estimate1RMAdded(b.value, b.reps ?? 1, b.bodyMassKg || bm)})`
                                : t === 'repeaters_7_3_20mm'
                                  ? `−${b.value} kg (${Math.round((b.value / b.bodyMassKg) * 100)} % BW) · ${b.repsToFailure ?? '?'} reps`
                                  : `${b.value} ${BENCHMARK_META[t].unit}`}
                          <button className="ml-2 text-xs text-bad" onClick={() => confirmAction('Delete result?') && void run(() => svc.softDelete('benchmarks', b.id), 'Deleted')}>
                            ×
                          </button>
                        </span>
                      </div>
                    ))}
                  </Card>
                ) : (
                  <p className="text-xs text-muted px-1">{BENCHMARK_META[t].help}</p>
                )}
              </Section>
            );
          })}
        </div>
      )}

      <QuickLogSheet open={quick} onClose={() => setQuick(false)} />
      {climb && <ClimbSheet open onClose={() => setClimb(false)} />}
      <CheckinSheet open={checkin} onClose={() => setCheckin(false)} />
      <SleepSheet open={sleep} onClose={() => setSleep(false)} />
      {bench && <BenchmarkSheet open onClose={() => setBench(null)} initialType={bench} />}
    </div>
  );
}
