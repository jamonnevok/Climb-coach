/**
 * SESSION: guided mode + timer + Tindeq.
 *  - full-screen colour (green work / red rest / amber get ready), large digits,
 *    beeps, voice countdown (last 3 s), vibration, Screen Wake Lock, fully offline;
 *  - pause / skip / skip set / add or remove a set on the fly;
 *  - after each set: completed Y/N, load, RPE, finger feeling (+ Tindeq peak / curve);
 *  - repeaters with Tindeq: force-drop detection proposes (or auto-ends) the set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { thresholds } from '../../config';
import type { BenchmarkResult, ExerciseDef, Hand, PlannedItem, PlannedSession, Scale5 } from '../../data/schema';
import { findSession } from '../../engine/planOps';
import { addSet, createTimer, currentPhase, formatClock, isDone, pause, progress, remainingS, removeSet, resume, skip, skipSet, tick, type TimerEvent, type TimerState } from '../../timer/timerEngine';
import { changeSetCount, currentItem, finish, isFinished, itemComplete, next, previous, recordSet, setsForItem, skipItem, startGuided, type GuidedState, type QuickSetInput } from '../../timer/guidedSession';
import { Cues } from '../../timer/cues';
import { ScreenWakeLock } from '../../timer/wakeLock';
import { getProgressor } from '../../tindeq/webBluetooth';
import { bandStatus, criticalForce, downsample, peak as peakOf, round1, type Pt } from '../../tindeq/forceAnalysis';
import { RepeaterMonitor } from '../../tindeq/repeaterMonitor';
import type { ProgressorSnapshot } from '../../tindeq/progressor';
import { useStore } from '../store';
import { navigate } from '../router';
import { fmtLoad, itemSummary } from '../format';
import { Badge, Button, Card, Empty, EvidenceBadge, Field, NumberInput, ReferenceList, Scale10Input, Scale5Input, Section, Segmented, Sheet, Toggle } from '../components/ui';
import { ForceCurveChart } from '../components/charts';
import { BodyMap } from '../components/bodyParts';
import { PainSheet } from '../components/forms';
import type { BodyLocation } from '../../data/schema';

/* ---------------- Tindeq hook ---------------- */

export function useProgressor(): ProgressorSnapshot {
  const p = getProgressor();
  const [snap, setSnap] = useState(p.snapshot);
  useEffect(() => p.subscribe(setSnap), [p]);
  return snap;
}

export function TindeqConnect({ compact }: { compact?: boolean }) {
  const { d, svc, run } = useStore();
  const snap = useProgressor();
  const p = getProgressor();
  if (snap.state === 'unsupported') return compact ? null : <p className="text-xs text-muted">Web Bluetooth unavailable in this browser — enter values manually (use Chrome on Android or desktop).</p>;
  const connect = () =>
    void run(async () => {
      const ok = await p.connect(d.settings.tindeq.deviceId, true);
      const s = p.snapshot;
      if (ok && s.deviceId && s.deviceId !== d.settings.tindeq.deviceId) await svc.updateSettings({ tindeq: { deviceId: s.deviceId, deviceName: s.deviceName } });
      if (!ok) throw new Error(s.error ?? 'Could not connect');
    }, 'Progressor connected');
  const battery = snap.batteryMv ? Math.round(Math.min(100, Math.max(0, ((snap.batteryMv - 3000) / 1200) * 100))) : null;
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="text-sm">
        <span className={snap.state === 'connected' ? 'text-ok' : 'text-muted'}>● </span>
        Tindeq {snap.state === 'connected' ? snap.deviceName : snap.state}
        {battery !== null && <span className="text-muted"> · {battery} %</span>}
        {snap.lowPower && <span className="text-warn"> · low battery</span>}
        {snap.error && snap.state !== 'connected' && <div className="text-xs text-warn">{snap.error}</div>}
      </div>
      {snap.state === 'connected' ? (
        <Button small tone="ghost" onClick={() => void p.disconnect()}>
          Disconnect
        </Button>
      ) : (
        <Button small onClick={connect} disabled={snap.state === 'connecting' || snap.state === 'reconnecting'}>
          {d.settings.tindeq.deviceId ? 'Reconnect' : 'Connect'}
        </Button>
      )}
    </div>
  );
}

/* ---------------- Set input ---------------- */

function SetInputSheet({
  item,
  ex,
  setNo,
  defaults,
  onSave,
}: {
  item: PlannedItem;
  ex: ExerciseDef | undefined;
  setNo: number;
  defaults: Partial<QuickSetInput>;
  onSave: (v: QuickSetInput) => void;
}) {
  const [completed, setCompleted] = useState(defaults.completed ?? true);
  const [load, setLoad] = useState<number | null>(item.load.value);
  const [rpe, setRpe] = useState<number | undefined>(undefined);
  const [feel, setFeel] = useState<Scale5 | undefined>(undefined);
  const [hand, setHand] = useState<Hand>(defaults.hand ?? 'both');
  const [reps, setReps] = useState<number | null>(defaults.reps ?? item.timer.reps);
  const finger = ex && ex.fingerIntensity !== 'none';
  const perHand = ex?.equipment.some((e) => ['no_hang_device', 'loading_pin', 'tindeq'].includes(e)) ?? false;
  return (
    <Sheet open onClose={() => onSave({ completed, loadValue: load, rpe, fingerFeeling: feel, reps: reps ?? undefined, hand, ...pickTindeq(defaults) })} title={`Set ${setNo} — ${ex?.name ?? ''}`}>
      <div className="space-y-4">
        <Segmented value={completed ? 'y' : 'n'} onChange={(v) => setCompleted(v === 'y')} options={[{ value: 'y', label: 'Completed' }, { value: 'n', label: 'Failed / cut short' }]} />
        {defaults.peakForceKg !== undefined && (
          <div className="text-sm">
            Tindeq peak <b>{defaults.peakForceKg} kg</b>
            {defaults.endedByForceDrop ? <span className="text-warn"> · ended by force drop</span> : null}
          </div>
        )}
        {!['none', 'grade', 'bodyweight'].includes(item.load.mode) && (
          <Field label={`Load (${fmtLoad(item.load.mode, 0).replace(/[+−-]?0 /, '').replace('target 0', 'target')})`}>
            <NumberInput value={load} onChange={setLoad} step={0.5} />
          </Field>
        )}
        {(item.timer.kind === 'reps' || item.timer.kind === 'repeaters' || !completed) && (
          <Field label={item.timer.kind === 'repeaters' ? 'Cycles completed' : 'Reps completed'}>
            <NumberInput value={reps} onChange={setReps} min={0} />
          </Field>
        )}
        {perHand && <Segmented value={hand} onChange={setHand} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }, { value: 'both', label: 'Both' }]} />}
        <Field label="RPE (0-10)">
          <Scale10Input value={rpe} onChange={setRpe} />
        </Field>
        {finger && (
          <Field label="Finger feeling">
            <Scale5Input value={feel} onChange={setFeel} low="Painful" high="Perfect" />
          </Field>
        )}
        <Button className="w-full" onClick={() => onSave({ completed, loadValue: load, rpe, fingerFeeling: feel, reps: reps ?? undefined, hand, ...pickTindeq(defaults) })}>
          Save set
        </Button>
      </div>
    </Sheet>
  );
}

const pickTindeq = (d: Partial<QuickSetInput>) => ({ peakForceKg: d.peakForceKg, forceCurveId: d.forceCurveId, endedByForceDrop: d.endedByForceDrop });

/* ---------------- Runner ---------------- */

const PHASE_BG: Record<string, string> = {
  prepare: 'bg-amber-500 text-black',
  work: 'bg-green-600 text-white',
  rest: 'bg-red-600 text-white',
  setRest: 'bg-red-700 text-white',
  done: 'bg-card text-fg',
};
const PHASE_LABEL: Record<string, string> = { prepare: 'Get ready', work: 'Work', rest: 'Rest', setRest: 'Rest', done: 'Done' };

interface Captured {
  points: Pt[];
  reps: number;
  dropStop: boolean;
}

function Runner({ session }: { session: PlannedSession }) {
  const { d, svc, toast } = useStore();
  const [g, setG] = useState<GuidedState>(() => startGuided(session));
  const [timer, setTimerState] = useState<TimerState | null>(null);
  const timerRef = useRef<TimerState | null>(null);
  const setTimer = useCallback((t: TimerState | null) => {
    timerRef.current = t;
    setTimerState(t);
  }, []);
  const [now, setNow] = useState(Date.now());
  const [pendingSet, setPendingSet] = useState<Partial<QuickSetInput> | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [autoEnd, setAutoEnd] = useState(true);
  const [painOpen, setPainOpen] = useState(false);
  const [painLoc, setPainLoc] = useState<BodyLocation | null>(null);
  const cues = useMemo(() => new Cues(), []);
  const wake = useMemo(() => new ScreenWakeLock(), []);
  const tq = useProgressor();
  const prog = getProgressor();
  const monitor = useRef<RepeaterMonitor | null>(null);
  const captured = useRef<Captured>({ points: [], reps: 0, dropStop: false });
  const workStartT = useRef<number | null>(null);
  const curves = useRef<{ setIndex: number; itemId: string; hand: Hand; points: Pt[] }[]>([]);

  const item = currentItem(g);
  const ex = item ? d.lib.get(item.exerciseId) : undefined;
  const usesForce = !!ex && tq.state === 'connected' && (ex.loadMode === 'target_force_kg' || ex.category === 'finger' || ex.category === 'test' || ex.category === 'prehab') && ex.fingerIntensity !== 'none';
  const target = item?.load.mode === 'target_force_kg' ? item.load.value : null;

  useEffect(() => {
    void wake.enable();
    return () => void wake.disable();
  }, [wake]);

  // Feed samples to the repeater monitor / capture buffer.
  useEffect(() => {
    if (!usesForce) return;
    return prog.onSample((p) => {
      if (prog.isRecording) monitor.current?.addSample(p);
    });
  }, [prog, usesForce]);

  const handleEvents = useCallback(
    (events: TimerEvent[], st: TimerState, t: number) => {
      cues.handle(events);
      for (const e of events) {
        if (e.type === 'phase_start' && e.phase.kind === 'work' && usesForce) {
          if (!prog.isRecording) {
            prog.startRecording();
            captured.current = { points: [], reps: 0, dropStop: false };
            monitor.current = new RepeaterMonitor(target);
          }
          workStartT.current = t;
          monitor.current?.workStarted(monitor.current.samples.length ? monitor.current.samples[monitor.current.samples.length - 1].t : 0);
        }
        if (e.type === 'phase_start' && e.phase.kind !== 'work' && usesForce && workStartT.current !== null && monitor.current) {
          const last = monitor.current.samples[monitor.current.samples.length - 1]?.t ?? 0;
          const r = monitor.current.workEnded(last);
          workStartT.current = null;
          captured.current.reps++;
          if (r?.decision.stop && st.pattern.kind === 'repeaters' && currentPhase(st).kind === 'rest') {
            captured.current.dropStop = true;
            toast(r.decision.reason ?? 'Force drop', 'info');
            if (autoEnd) {
              const s2 = skipSet(st, t);
              setTimer(s2.state);
              handleEvents(s2.events, s2.state, t);
              return;
            }
          }
        }
        if (e.type === 'set_complete') {
          let pk: number | undefined;
          if (usesForce && prog.isRecording) {
            const pts = prog.stopRecording();
            pk = pts.length ? Math.round(peakOf(pts) * 10) / 10 : undefined;
            captured.current.points = pts;
            if (pts.length) curves.current.push({ setIndex: e.setIndex, itemId: item!.id, hand: 'both', points: pts });
          }
          setPendingSet({
            completed: !captured.current.dropStop || st.pattern.kind !== 'repeaters' ? true : captured.current.reps >= st.pattern.reps,
            reps: st.pattern.kind === 'repeaters' ? captured.current.reps || st.pattern.reps : undefined,
            peakForceKg: pk,
            endedByForceDrop: captured.current.dropStop || undefined,
          });
          monitor.current = null;
        }
      }
    },
    [cues, prog, usesForce, target, autoEnd, toast, item, setTimer],
  );

  // Clock (wall-clock based; state kept in a ref so ticks never run inside a React updater).
  const running = !!timer && !timer.paused && !isDone(timer);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const cur = timerRef.current;
      if (!cur) return;
      const r = tick(cur, t);
      if (r.state !== cur) setTimer(r.state);
      if (r.events.length) handleEvents(r.events, r.state, t);
    }, 100);
    return () => clearInterval(id);
  }, [running, handleEvents, setTimer]);

  const startItem = () => {
    if (!item) return;
    cues.unlock();
    const remaining = Math.max(1, (g.setCounts[item.id] ?? item.timer.sets) - setsForItem(g, item.id).length);
    const r = createTimer({ ...item.timer, sets: remaining }, Date.now(), { prepareS: thresholds.timer.prepareS, countdownLastS: thresholds.timer.countdownLastS });
    setTimer(r.state);
    cues.handle(r.events);
  };

  const saveSet = async (v: QuickSetInput) => {
    let curveId: string | undefined;
    const c = curves.current[curves.current.length - 1];
    if (c && c.itemId === item?.id && v.peakForceKg !== undefined) {
      const ds = round1(downsample(c.points));
      const saved = await svc.saveForceCurve({ takenAt: new Date().toISOString(), hand: v.hand ?? 'both', t: ds.t, f: ds.f, peakKg: v.peakForceKg, meanKg: 0, context: item && d.lib.get(item.exerciseId)?.category === 'test' ? 'test' : 'set' });
      curveId = saved.id;
      c.hand = v.hand ?? 'both';
    }
    setG((cur) => recordSet(cur, { ...v, forceCurveId: curveId }));
    setPendingSet(null);
  };

  const goNext = () => {
    setTimer(null);
    setG((cur) => next(cur));
  };

  if (finishing || isFinished(g)) {
    return <FinishScreen g={g} session={session} curves={curves.current} onBack={() => setFinishing(false)} />;
  }
  if (!item) return null;

  const phase = timer ? currentPhase(timer) : null;
  const rem = timer ? remainingS(timer, now) : null;
  const pr = timer ? progress(timer, now) : null;
  const doneSets = setsForItem(g, item.id).length;
  const totalSets = g.setCounts[item.id] ?? item.timer.sets;
  const band = usesForce ? bandStatus(tq.currentKg, target) : 'idle';
  const bg = phase ? PHASE_BG[phase.kind] : 'bg-card text-fg';

  return (
    <div className={`fixed inset-0 z-30 flex flex-col transition-colors duration-300 ${bg}`}>
      <div className="flex items-center justify-between p-4 text-sm">
        <button onClick={() => confirm('Leave the guided session? Logged sets are kept until you finish.') && navigate('today')} className="opacity-80">
          ✕ Exit
        </button>
        <span className="opacity-80">
          {g.itemIndex + 1}/{g.items.length} · set {Math.min(totalSets, doneSets + 1)}/{totalSets}
        </span>
        <button onClick={() => setFinishing(true)} className="opacity-80">
          Finish
        </button>
      </div>

      <div className="px-5">
        <div className="text-xs uppercase tracking-widest opacity-80">{item.role}</div>
        <h2 className="text-2xl font-bold leading-tight">{ex?.name ?? item.exerciseId}</h2>
        <div className="opacity-90 text-sm">{itemSummary(item, ex, d.profile.bodyMassKg)}</div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-5">
        {timer && phase ? (
          <>
            <div className="text-2xl font-semibold uppercase tracking-widest">{PHASE_LABEL[phase.kind]}</div>
            <div className="text-[28vw] sm:text-[160px] leading-none font-bold tabular">{phase.durationS === null ? '' : formatClock(rem)}</div>
            {phase.durationS === null && (
              <Button className="w-56 h-24 text-2xl" tone="subtle" onClick={() => { const r = skip(timer, Date.now()); setTimer(r.state); handleEvents(r.events, r.state, Date.now()); }}>
                Set done
              </Button>
            )}
            {pr && (
              <div className="text-sm opacity-90 mt-2">
                {phase.kind !== 'prepare' && phase.kind !== 'done' ? `Set ${pr.set}/${pr.sets}${pr.reps > 1 ? ` · rep ${pr.rep}/${pr.reps}` : ''}` : ''}
              </div>
            )}
            {usesForce && (
              <div className="mt-4 text-center">
                <div className={`text-5xl font-bold tabular ${band === 'below' ? 'opacity-70' : ''}`}>{tq.currentKg.toFixed(1)} kg</div>
                <div className="text-sm opacity-90">
                  peak {tq.peakKg.toFixed(1)} kg{target ? ` · target ${target} kg ${band === 'in' ? '✓' : band === 'below' ? '↑ pull harder' : band === 'above' ? '↓ ease off' : ''}` : ''}
                </div>
              </div>
            )}
            {pr && <div className="w-full max-w-md h-1.5 bg-black/20 rounded-full mt-6 overflow-hidden"><div className="h-full bg-white/80" style={{ width: `${pr.fraction * 100}%` }} /></div>}
          </>
        ) : (
          <div className="w-full max-w-md space-y-3">
            {ex && (
              <Card className="space-y-2 text-fg">
                <div className="flex gap-2 items-center">
                  <EvidenceBadge level={ex.evidence} />
                </div>
                <p className="text-sm">{ex.rationale}</p>
                {ex.cues && (
                  <ul className="text-sm list-disc pl-5 text-muted">
                    {ex.cues.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                <ReferenceList ids={ex.references} />
                {item.notes && <p className="text-xs text-warn">{item.notes}</p>}
              </Card>
            )}
            {ex && ex.fingerIntensity !== 'none' && (
              <Card className="space-y-2 text-fg">
                <TindeqConnect />
                {tq.state === 'connected' && (
                  <>
                    <div className="flex gap-2">
                      <Button small tone="ghost" onClick={() => void (tq.streaming ? prog.tare() : prog.startStream().then(() => setTimeout(() => void prog.tare(), 700)))}>
                        {tq.streaming ? 'Tare' : 'Start force stream'}
                      </Button>
                      {tq.streaming && <span className="text-sm self-center tabular">{tq.currentKg.toFixed(1)} kg</span>}
                    </div>
                    {item.timer.kind === 'repeaters' && <Toggle checked={autoEnd} onChange={setAutoEnd} label="Auto-end set on force drop" />}
                  </>
                )}
              </Card>
            )}
            {itemComplete(g) ? (
              <Button className="w-full h-16 text-lg" onClick={goNext}>
                Next exercise →
              </Button>
            ) : (
              <Button className="w-full h-16 text-lg" onClick={startItem}>
                {doneSets ? `Continue (set ${doneSets + 1}/${totalSets})` : 'Start'}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2 p-4 safe-bottom">
        {timer ? (
          <>
            <Button tone="subtle" onClick={() => setTimer(timer.paused ? resume(timer, Date.now()) : pause(timer, Date.now()))}>
              {timer.paused ? 'Resume' : 'Pause'}
            </Button>
            <Button tone="subtle" onClick={() => { const r = skip(timer, Date.now()); setTimer(r.state); handleEvents(r.events, r.state, Date.now()); }}>
              Skip
            </Button>
            <Button tone="subtle" onClick={() => { setTimer(addSet(timer)); setG((c) => changeSetCount(c, 1)); }}>
              + Set
            </Button>
            <Button tone="subtle" onClick={() => { const r = removeSet(timer); if (r !== timer) { setTimer(r); setG((c) => changeSetCount(c, -1)); } }}>
              − Set
            </Button>
          </>
        ) : (
          <>
            <Button tone="subtle" onClick={() => setG((c) => previous(c))} disabled={g.itemIndex === 0}>
              ‹ Prev
            </Button>
            <Button tone="subtle" onClick={() => setG((c) => skipItem(c))}>
              Skip ex.
            </Button>
            <Button tone="subtle" onClick={() => setG((c) => changeSetCount(c, 1))}>
              + Set
            </Button>
            <Button tone="subtle" onClick={() => setPainOpen(true)}>
              Pain?
            </Button>
          </>
        )}
      </div>
      {timer && isDone(timer) && !pendingSet && (
        <div className="absolute inset-x-4 bottom-24">
          <Button className="w-full h-14" onClick={itemComplete(g) ? goNext : startItem}>
            {itemComplete(g) ? 'Next exercise →' : 'Next set'}
          </Button>
        </div>
      )}
      {pendingSet && item && <SetInputSheet item={item} ex={ex} setNo={doneSets + 1} defaults={pendingSet} onSave={(v) => void saveSet(v)} />}
      <Sheet open={painOpen} onClose={() => setPainOpen(false)} title="Where does it hurt?">
        <BodyMap evals={d.painEvals} onPick={(l) => { setPainLoc(l); setPainOpen(false); }} />
      </Sheet>
      <PainSheet open={!!painLoc} location={painLoc} onClose={() => setPainLoc(null)} />
    </div>
  );
}

/* ---------------- Finish ---------------- */

function FinishScreen({ g, session, curves, onBack }: { g: GuidedState; session: PlannedSession; curves: { itemId: string; hand: Hand; points: Pt[] }[]; onBack: () => void }) {
  const { d, svc, run } = useStore();
  const [rpe, setRpe] = useState<number | undefined>(session.estSessionRPE);
  const [dur, setDur] = useState<number | null>(Math.max(1, Math.round((Date.now() - Date.parse(g.startedAt)) / 60000)));
  const [notes, setNotes] = useState('');
  const [painAfter, setPainAfter] = useState(false);
  const tests = g.sets.filter((s) => d.lib.get(s.exerciseId)?.category === 'test');
  const tindeqBench: Omit<BenchmarkResult, 'id' | 'createdAt' | 'updatedAt'>[] = [];
  for (const hand of ['left', 'right'] as const) {
    const pf = tests.filter((s) => s.exerciseId === 'test_peak_force' && s.hand === hand && s.peakForceKg);
    if (pf.length) tindeqBench.push({ date: d.today, type: 'tindeq_peak_force', value: Math.max(...pf.map((s) => s.peakForceKg!)), unit: 'kg', bodyMassKg: d.profile.bodyMassKg, hand, source: 'tindeq' });
    const cfCurve = curves.find((c) => c.hand === hand && g.items.find((i) => i.id === c.itemId)?.exerciseId === 'test_critical_force');
    if (cfCurve) {
      const reps = Array.from({ length: 24 }, (_, i) => ({ start: i * 10_000, end: i * 10_000 + 7000 }));
      const t0 = cfCurve.points.find((p) => p.f > 2)?.t ?? 0;
      const stats = reps.map((r, i) => {
        const xs = cfCurve.points.filter((p) => p.t >= t0 + r.start + 500 && p.t <= t0 + r.end);
        const m = xs.length ? xs.reduce((a, p) => a + p.f, 0) / xs.length : 0;
        return { index: i, startMs: r.start, endMs: r.end, meanKg: m, peakKg: xs.length ? Math.max(...xs.map((p) => p.f)) : 0, loadedFraction: 1 };
      });
      const cf = criticalForce(stats.filter((s) => s.meanKg > 0));
      if (cf) tindeqBench.push({ date: d.today, type: 'tindeq_critical_force', value: cf.cfKg, unit: 'kg', bodyMassKg: d.profile.bodyMassKg, hand, source: 'tindeq', notes: `Peak ${cf.peakKg} kg, CF ${cf.cfPctOfPeak} % of peak` });
    }
  }
  const save = () =>
    void run(async () => {
      const planned = session.id.startsWith('adhoc-') ? { ...finish(g, { sessionRPE: rpe ?? 5, durationMin: dur ?? undefined, notes: notes || undefined }), plannedSessionId: undefined } : finish(g, { sessionRPE: rpe ?? 5, durationMin: dur ?? undefined, notes: notes || undefined });
      await svc.saveSession({ ...planned, date: d.today });
      for (const b of tindeqBench) await svc.saveBenchmark(b);
      navigate(painAfter ? 'body/cooldown' : session.kind === 'test' ? 'log/benchmarks' : 'today');
    }, painAfter ? 'Session saved — now tap where it hurts' : 'Session saved');
  return (
    <div className="fixed inset-0 z-30 bg-bg overflow-y-auto p-5 space-y-5">
      <h2 className="text-2xl font-bold">Finish session</h2>
      <Card className="space-y-1 text-sm">
        <div>{g.sets.length} sets logged · {g.sets.filter((s) => !s.completed).length} failed</div>
        {g.skippedItems.length > 0 && <div className="text-muted">{g.skippedItems.length} exercise(s) skipped</div>}
      </Card>
      <Field label="Session RPE (0-10)" hint="Whole session, ~30 min after (Foster CR-10).">
        <Scale10Input value={rpe} onChange={setRpe} />
      </Field>
      <Field label="Duration (min)">
        <NumberInput value={dur} onChange={setDur} />
      </Field>
      <Toggle checked={painAfter} onChange={setPainAfter} label="Any pain at cool-down? (record location next)" />
      <Field label="Notes">
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {tindeqBench.length > 0 && (
        <Card className="text-sm space-y-1">
          <div className="font-semibold">Tindeq results to save as benchmarks</div>
          {tindeqBench.map((b) => (
            <div key={b.type + b.hand}>
              {b.type === 'tindeq_peak_force' ? 'Peak force' : 'Critical force'} {b.hand}: {b.value} kg
            </div>
          ))}
        </Card>
      )}
      {session.kind === 'test' && <p className="text-sm text-muted">After saving, enter the other test results on Log → Benchmarks (max hang, pull-up, repeaters, lock-off, front lever, board max).</p>}
      {curves.length > 0 && (
        <Section title="Force curves">
          {curves.slice(-4).map((c, i) => (
            <Card key={i}>
              <ForceCurveChart t={c.points.map((p) => p.t)} f={c.points.map((p) => p.f)} />
            </Card>
          ))}
        </Section>
      )}
      <div className="flex gap-2 pb-8">
        <Button tone="ghost" onClick={onBack}>
          Back
        </Button>
        <Button className="flex-1" onClick={save}>
          Save session
        </Button>
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */

export function SessionPage({ parts }: { parts: string[] }) {
  const { d } = useStore();
  const id = parts[1];
  const plan = d.plan;
  if (id === 'free') {
    return <FreeTimer />;
  }
  if (id === 'test' && parts[2]) {
    const ex = d.lib.get(parts[2]);
    if (!ex) return <Empty>Unknown test.</Empty>;
    const s: PlannedSession = {
      id: `adhoc-${ex.id}`, date: d.today, kind: ex.category === 'test' ? 'test' : 'training', title: ex.name, estDurationMin: 20, estSessionRPE: 8, fingerIntensity: ex.fingerIntensity, estFingerLoad: 0, location: 'home', status: 'planned',
      items: [{ id: 'adhoc-item', exerciseId: ex.id, role: 'main', timer: { ...ex.timer }, load: { mode: ex.loadMode, value: null }, grip: ex.defaultGrip, edgeMm: ex.edgeMm }],
    };
    return <Runner session={s} />;
  }
  const found = id && plan ? findSession(plan, id) : null;
  if (found) return <Runner session={found.session} />;
  return <SessionPicker />;
}

function SessionPicker() {
  const { d } = useStore();
  const upcoming = d.plan ? d.plan.weeks.flatMap((w) => w.sessions).filter((s) => s.status === 'planned' && s.date >= d.today).slice(0, 6) : [];
  const tests = [...d.lib.values()].filter((e) => e.category === 'test');
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Session</h1>
      <Section title="Planned">
        {upcoming.length ? (
          <div className="space-y-2">
            {upcoming.map((s) => (
              <Card key={s.id} onClick={() => navigate(`session/${s.id}`)} className="flex justify-between gap-2">
                <span>{s.title}</span>
                <span className="text-sm text-muted">{s.date === d.today ? 'today' : s.date}</span>
              </Card>
            ))}
          </div>
        ) : (
          <Empty>No upcoming planned session.</Empty>
        )}
      </Section>
      <Section title="Tests">
        <div className="space-y-2">
          {tests.map((t) => (
            <Card key={t.id} onClick={() => navigate(`session/test/${t.id}`)} className="flex justify-between gap-2">
              <span>{t.name.replace('TEST: ', '')}</span>
              {t.equipment.includes('tindeq') && <Badge>Tindeq</Badge>}
            </Card>
          ))}
        </div>
      </Section>
      <Section title="Tools">
        <Card onClick={() => navigate('session/free')}>Free timer (any protocol)</Card>
        <Card>
          <TindeqConnect />
        </Card>
      </Section>
    </div>
  );
}

/** Free timer: pick any protocol from the library and run it (no logging). */
function FreeTimer() {
  const { d } = useStore();
  const [exId, setExId] = useState('repeaters_7_3');
  const ex = d.lib.get(exId);
  if (!ex) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Free timer</h1>
      <select value={exId} onChange={(e) => setExId(e.target.value)}>
        {[...d.lib.values()].filter((e) => e.timer.kind !== 'none').map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <Card className="text-sm text-muted">Runs the protocol with all cues; sets you record are saved as a session when you finish.</Card>
      <Button className="w-full" onClick={() => navigate(`session/test/${exId}`)}>
        Start
      </Button>
    </div>
  );
}
