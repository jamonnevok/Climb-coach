/**
 * PLAN: macro timeline, weekly cards (drag & drop between days — long-press on touch),
 * session editor (swap / edit sets, reps, loads), unavailable & outdoor days, validate,
 * projected ACWR, projecting phases, version history.
 */
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { addDays, startOfWeek, type ISODate } from '../../lib/dates';
import type { ExerciseDef, Plan, PlannedItem, PlannedSession, PlanWeek } from '../../data/schema';
import { addItem, findSession, moveSession, removeItem, swapExercise, toggleDayFlag, updateItem } from '../../engine/planOps';
import type { RuleViolation } from '../../engine/planRules';
import { useStore } from '../store';
import { navigate } from '../router';
import { BLOCK_COLORS, BLOCK_LABELS, SESSION_KIND_LABELS, fmtDate, fmtDay, fmtLoad, fmtNum, fmtTimer, GRIP_LABELS } from '../format';
import { Badge, Button, Card, Empty, EvidenceBadge, Field, NumberInput, ReferenceList, Section, Sheet, Stepper, confirmAction } from '../components/ui';
import { LineChart } from '../components/charts';

/* ---------------- Macro ---------------- */

function MacroView({ plan, today }: { plan: Plan; today: ISODate }) {
  const { svc, run } = useStore();
  const total = plan.macro.reduce((a, b) => a + b.weeks, 0);
  const [phaseOpen, setPhaseOpen] = useState(false);
  const [start, setStart] = useState(addDays(startOfWeek(today), 14));
  const [weeks, setWeeks] = useState(3);
  return (
    <Card className="space-y-3">
      <div className="flex h-8 rounded-lg overflow-hidden">
        {plan.macro.map((b, i) => (
          <div
            key={b.id}
            title={`${BLOCK_LABELS[b.kind]} ${b.weeks} wk`}
            className={`${BLOCK_COLORS[b.kind]} ${i === plan.currentBlockIndex ? '' : 'opacity-40'} flex items-center justify-center text-[10px] font-semibold text-black border-r border-bg`}
            style={{ width: `${(b.weeks / total) * 100}%` }}
          >
            {b.weeks >= 3 ? BLOCK_LABELS[b.kind].slice(0, 5) : ''}
          </div>
        ))}
      </div>
      <ul className="text-sm space-y-1">
        {plan.macro.map((b, i) => (
          <li key={b.id} className={`flex justify-between gap-2 ${i === plan.currentBlockIndex ? 'font-semibold' : 'text-muted'}`}>
            <span>
              {BLOCK_LABELS[b.kind]} · {b.weeks} wk{b.deloadWeekIndex !== null ? ' (deload + re-test last)' : ''}
            </span>
            <span className="flex items-center gap-2">
              {fmtDate(b.startDate, { day: 'numeric', month: 'short' })}
              {b.userInserted && (
                <button className="text-bad text-xs" onClick={() => confirmAction('Remove this projecting phase and regenerate?') && void run(() => svc.removeProjectingPhase(b.id), 'Phase removed')}>
                  remove
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {plan.targetDate && <p className="text-xs text-muted">Built backwards from target {fmtDate(plan.targetDate)} with taper.</p>}
      <Button tone="ghost" small onClick={() => setPhaseOpen(true)}>
        Insert projecting phase
      </Button>
      <Sheet open={phaseOpen} onClose={() => setPhaseOpen(false)} title="Projecting phase">
        <div className="space-y-4">
          <p className="text-sm text-muted">During a projecting phase, finger training switches to low-volume maintenance (2 short home sessions) around projecting days.</p>
          <Field label="Start (Monday of that week)">
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Weeks">
            <Stepper value={weeks} onChange={setWeeks} min={1} max={8} />
          </Field>
          <Button className="w-full" onClick={() => void run(async () => { await svc.insertProjectingPhase(start, weeks); setPhaseOpen(false); }, 'Plan regenerated with projecting phase')}>
            Insert & regenerate (draft)
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

/* ---------------- Session editor ---------------- */

function ItemEditor({ item, plan, session, onPlan }: { item: PlannedItem; plan: Plan; session: PlannedSession; onPlan: (p: Plan, reason: string, v?: RuleViolation[]) => void }) {
  const { d } = useStore();
  const ex = d.lib.get(item.exerciseId);
  const [open, setOpen] = useState(false);
  const [swap, setSwap] = useState(false);
  const [q, setQ] = useState('');
  const up = (patch: Partial<Omit<PlannedItem, 'id'>>, why: string) => {
    const r = updateItem(plan, session.id, item.id, patch, d.lib, d.ctx);
    onPlan(r.plan, why, r.violations);
  };
  const options = useMemo(
    () => [...d.lib.values()].filter((e) => (ex ? e.category === ex.category || e.category === 'finger' || e.category === 'technique' : true)).filter((e) => e.name.toLowerCase().includes(q.toLowerCase())),
    [d.lib, ex, q],
  );
  const editableLoad = !['none', 'grade', 'bodyweight'].includes(item.load.mode);
  return (
    <div className="border border-line rounded-xl">
      <button className="w-full text-left p-3 flex justify-between gap-2" onClick={() => setOpen(!open)}>
        <span>
          <span className="text-xs text-muted uppercase mr-2">{item.role}</span>
          {ex?.name ?? item.exerciseId}
        </span>
        <span className="text-sm text-muted text-right">
          {fmtTimer(item.timer)} {fmtLoad(item.load.mode, item.load.value, d.profile.bodyMassKg)}
        </span>
      </button>
      {open && ex && (
        <div className="p-3 pt-0 space-y-3">
          <div className="flex gap-2 items-center flex-wrap">
            <EvidenceBadge level={ex.evidence} />
            {ex.custom && <Badge>Custom</Badge>}
          </div>
          <p className="text-sm">{ex.rationale}</p>
          <ReferenceList ids={ex.references} />
          {item.notes && <p className="text-xs text-warn">{item.notes}</p>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sets">
              <Stepper value={item.timer.sets} onChange={(v) => up({ timer: { ...item.timer, sets: v } }, `${ex.name}: ${v} sets`)} min={1} />
            </Field>
            {item.timer.kind !== 'arc' && item.timer.kind !== 'countdown' ? (
              <Field label={item.timer.kind === 'repeaters' ? 'Cycles / set' : 'Reps'}>
                <Stepper value={item.timer.reps} onChange={(v) => up({ timer: { ...item.timer, reps: v } }, `${ex.name}: ${v} reps`)} min={1} />
              </Field>
            ) : (
              <Field label="Minutes">
                <Stepper value={Math.round((item.timer.totalS ?? 0) / 60)} onChange={(v) => up({ timer: { ...item.timer, totalS: v * 60 } }, `${ex.name}: ${v} min`)} min={1} step={5} />
              </Field>
            )}
            {['hang', 'repeaters', 'isometric', 'interval', 'emom'].includes(item.timer.kind) && (
              <Field label="Work (s)">
                <NumberInput value={item.timer.workS} onChange={(v) => up({ timer: { ...item.timer, workS: v ?? 0 } }, `${ex.name}: work ${v} s`)} />
              </Field>
            )}
            {['repeaters', 'interval', 'emom', 'isometric'].includes(item.timer.kind) && (
              <Field label="Rest (s)">
                <NumberInput value={item.timer.restS} onChange={(v) => up({ timer: { ...item.timer, restS: v ?? 0 } }, `${ex.name}: rest ${v} s`)} />
              </Field>
            )}
            <Field label="Rest between sets (s)">
              <NumberInput value={item.timer.setRestS} onChange={(v) => up({ timer: { ...item.timer, setRestS: v ?? 0 } }, `${ex.name}: set rest ${v} s`)} step={15} />
            </Field>
            {editableLoad && (
              <Field label={fmtLoad(item.load.mode, 0).replace('+0 ', '').replace('target 0 ', 'target ') || 'Load'}>
                <NumberInput value={item.load.value} onChange={(v) => up({ load: { ...item.load, value: v } }, `${ex.name}: load ${v}`)} step={0.5} />
              </Field>
            )}
            {ex.gripOptions && ex.gripOptions.length > 1 && (
              <Field label="Grip">
                <select value={item.grip} onChange={(e) => up({ grip: e.target.value as PlannedItem['grip'] }, `${ex.name}: grip ${e.target.value}`)}>
                  {ex.gripOptions.map((g) => (
                    <option key={g} value={g}>
                      {GRIP_LABELS[g]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <div className="flex gap-2">
            <Button small tone="ghost" onClick={() => setSwap(true)}>
              Swap
            </Button>
            <Button
              small
              tone="ghost"
              onClick={() => {
                const r = removeItem(plan, session.id, item.id, d.lib, d.ctx);
                onPlan(r.plan, `${ex.name} removed`, r.violations);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      )}
      <Sheet open={swap} onClose={() => setSwap(false)} title="Swap exercise">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
        <div className="space-y-2">
          {options.map((e) => (
            <ExerciseRow
              key={e.id}
              ex={e}
              onPick={() => {
                const r = swapExercise(plan, session.id, item.id, e, d.lib, d.ctx);
                onPlan(r.plan, `${ex?.name ?? ''} → ${e.name}`, r.violations);
                setSwap(false);
              }}
            />
          ))}
        </div>
      </Sheet>
    </div>
  );
}

export function ExerciseRow({ ex, onPick }: { ex: ExerciseDef; onPick: () => void }) {
  return (
    <button onClick={onPick} className="w-full text-left border border-line rounded-xl p-3 active:bg-line/40">
      <div className="flex justify-between gap-2">
        <span className="font-medium">{ex.name}</span>
        <EvidenceBadge level={ex.evidence} />
      </div>
      <div className="text-xs text-muted mt-1">
        {ex.category} · finger {ex.fingerIntensity} · {fmtTimer(ex.timer)}
      </div>
    </button>
  );
}

function SessionEditor({ sessionId, plan, onClose, onPlan }: { sessionId: string; plan: Plan; onClose: () => void; onPlan: (p: Plan, reason: string, v?: RuleViolation[]) => void }) {
  const { d } = useStore();
  const found = findSession(plan, sessionId);
  const [add, setAdd] = useState(false);
  const [q, setQ] = useState('');
  if (!found) return null;
  const s = found.session;
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(found.week.startDate, i));
  return (
    <Sheet open onClose={onClose} title={s.title}>
      <div className="space-y-4">
        <div className="text-sm text-muted">
          {SESSION_KIND_LABELS[s.kind]} · {fmtDate(s.date)} · ~{s.estDurationMin} min · est. finger load {fmtNum(s.estFingerLoad, 0)} FLU
        </div>
        <Field label="Move to">
          <select
            value={s.date}
            onChange={(e) => {
              const r = moveSession(plan, s.id, e.target.value);
              onPlan(r.plan, `${s.title} moved to ${e.target.value}`, r.violations);
            }}
          >
            {weekDates.map((dt) => (
              <option key={dt} value={dt}>
                {fmtDate(dt)}
              </option>
            ))}
          </select>
        </Field>
        <div className="space-y-2">
          {s.items.map((i) => (
            <ItemEditor key={i.id} item={i} plan={plan} session={s} onPlan={onPlan} />
          ))}
        </div>
        <Button tone="ghost" className="w-full" onClick={() => setAdd(true)}>
          Add exercise
        </Button>
        {s.status === 'planned' && (
          <Button className="w-full" onClick={() => navigate(`session/${s.id}`)}>
            Start this session now
          </Button>
        )}
      </div>
      <Sheet open={add} onClose={() => setAdd(false)} title="Add exercise">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
        <div className="space-y-2">
          {[...d.lib.values()]
            .filter((e) => e.name.toLowerCase().includes(q.toLowerCase()))
            .map((e) => (
              <ExerciseRow
                key={e.id}
                ex={e}
                onPick={() => {
                  const r = addItem(plan, s.id, e, d.lib, d.ctx);
                  onPlan(r.plan, `${e.name} added to ${s.title}`, r.violations);
                  setAdd(false);
                }}
              />
            ))}
        </div>
      </Sheet>
    </Sheet>
  );
}

/* ---------------- Week board with drag & drop ---------------- */

interface DragState {
  id: string;
  x: number;
  y: number;
  title: string;
}

function WeekBoard({ week, plan, onPlan, onOpen }: { week: PlanWeek; plan: Plan; onPlan: (p: Plan, reason: string, v?: RuleViolation[]) => void; onOpen: (id: string) => void }) {
  const { d } = useStore();
  const [drag, setDrag] = useState<DragState | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week.startDate, i));

  const dateAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-date]') as HTMLElement | null;
    return el?.dataset.date ?? null;
  };
  const onDown = (s: PlannedSession) => (e: RPointerEvent) => {
    if (s.status !== 'planned') return;
    start.current = { x: e.clientX, y: e.clientY };
    const x = e.clientX;
    const y = e.clientY;
    timer.current = window.setTimeout(() => {
      setDrag({ id: s.id, x, y, title: s.title });
      if ('vibrate' in navigator) navigator.vibrate(30);
    }, e.pointerType === 'mouse' ? 120 : 350);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag) {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10 && timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      return;
    }
    e.preventDefault();
    setDrag({ ...drag, x: e.clientX, y: e.clientY });
    setOver(dateAt(e.clientX, e.clientY));
  };
  const onUp = (s: PlannedSession) => (e: RPointerEvent) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (drag) {
      const to = dateAt(e.clientX, e.clientY);
      if (to && to !== s.date) {
        const r = moveSession(plan, drag.id, to);
        onPlan(r.plan, `${s.title} moved to ${to}`, r.violations);
      }
      setDrag(null);
      setOver(null);
    } else if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) < 10) {
      onOpen(s.id);
    }
    start.current = null;
  };

  return (
    <div className="space-y-1 select-none" onPointerMove={onMove}>
      {days.map((dt) => {
        const ss = week.sessions.filter((s) => s.date === dt);
        const unavailable = week.unavailableDays.includes(dt) || d.settings.unavailableWeekdays.includes(days.indexOf(dt));
        const outdoor = week.outdoorDays.includes(dt);
        return (
          <div key={dt} data-date={dt} className={`flex gap-2 rounded-xl p-2 transition ${over === dt ? 'bg-accent/15 ring-1 ring-accent' : dt === d.today ? 'bg-line/40' : ''}`}>
            <div className="w-12 shrink-0 text-xs pt-1">
              <div className={dt === d.today ? 'text-accent font-semibold' : 'text-muted'}>{fmtDay(dt)}</div>
              <div className="text-muted">{Number(dt.slice(8))}</div>
              {unavailable && <div className="text-[10px] text-bad">busy</div>}
              {outdoor && <div className="text-[10px] text-ok">outdoor</div>}
            </div>
            <div className="flex-1 space-y-1 min-h-[40px]">
              {ss.map((s) => (
                <div
                  key={s.id}
                  onPointerDown={onDown(s)}
                  onPointerUp={onUp(s)}
                  onContextMenu={(e) => e.preventDefault()}
                  style={{ touchAction: drag ? 'none' : 'pan-y' }}
                  className={`rounded-lg px-3 py-2 text-sm border ${drag?.id === s.id ? 'opacity-30' : ''} ${
                    s.status === 'done' ? 'border-ok/50 bg-ok/10' : s.status === 'dropped' || s.status === 'missed' ? 'border-line opacity-50 line-through' : s.kind === 'prehab' || s.optional ? 'border-dashed border-line' : 'border-line bg-card'
                  }`}
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{s.title}</span>
                    <span className="text-xs text-muted">{s.estDurationMin}′</span>
                  </div>
                  {s.kind !== 'prehab' && (
                    <div className="text-xs text-muted">
                      finger {s.fingerIntensity} · {fmtNum(s.estFingerLoad, 0)} FLU{s.movedFrom ? ` · moved from ${fmtDay(s.movedFrom)}` : ''}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {drag && (
        <div className="fixed z-50 pointer-events-none rounded-lg px-3 py-2 text-sm bg-accent text-black shadow-xl" style={{ left: drag.x - 60, top: drag.y - 20 }}>
          {drag.title}
        </div>
      )}
      {drag && <div className="fixed inset-0 z-40" style={{ touchAction: 'none' }} onPointerMove={onMove} onPointerUp={(e) => { const s = week.sessions.find((x) => x.id === drag.id); if (s) onUp(s)(e); }} />}
    </div>
  );
}

/* ---------------- Page ---------------- */

export function PlanPage() {
  const { d, data, svc, run, toast } = useStore();
  const plan = d.plan;
  const [weekIdx, setWeekIdx] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [violations, setViolations] = useState<RuleViolation[]>([]);
  const [dayMenu, setDayMenu] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (!plan) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Plan</h1>
        <Card className="space-y-3">
          <p className="text-sm text-muted">Generate a plan from your profile, benchmarks and weaknesses. Without benchmarks, week 1 is an assessment week.</p>
          <Button className="w-full" onClick={() => void run(() => svc.generatePlan(), 'Draft plan generated — review and validate')}>
            Generate plan
          </Button>
        </Card>
      </div>
    );
  }

  const currentIdx = Math.max(0, plan.weeks.findIndex((w) => w.startDate <= d.today && d.today <= addDays(w.startDate, 6)));
  const wi = Math.min(plan.weeks.length - 1, weekIdx ?? currentIdx);
  const week = plan.weeks[wi];
  const block = plan.macro[plan.currentBlockIndex];
  const blockEnd = addDays(block.startDate, block.weeks * 7);
  const blockOver = d.today >= blockEnd;
  const onPlan = (p: Plan, reason: string, v: RuleViolation[] = []) => {
    setViolations(v);
    if (v.length) toast(`Rule warning: ${v[0].message}`, 'info');
    void run(() => svc.savePlanEdit(p, reason));
  };
  const proj = d.projection;
  const projSeries = proj ? proj.finger.series.slice(-21) : [];
  const versions = data.planVersions.filter((v) => v.planId === plan.id).sort((a, b) => b.version - a.version);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Plan</h1>
          <div className="text-sm text-muted">
            v{plan.version} · {plan.status === 'draft' ? 'draft — validate to activate' : 'active'}
          </div>
        </div>
        <Button small tone="ghost" onClick={() => setHistoryOpen(true)}>
          History
        </Button>
      </header>

      <MacroView plan={plan} today={d.today} />

      {blockOver && plan.macro[plan.currentBlockIndex + 1] && (
        <Card className="space-y-2 border-accent/60">
          <div className="font-semibold">Block finished</div>
          <p className="text-sm text-muted">Enter your re-test results (Log → Benchmarks) first, then build the next block from them.</p>
          <Button className="w-full" onClick={() => void run(() => svc.startNextBlock(), 'Next block ready — review and validate')}>
            Build {BLOCK_LABELS[plan.macro[plan.currentBlockIndex + 1].kind]} block
          </Button>
        </Card>
      )}

      <Section
        title={`Week ${week.index + 1}/${block.weeks}${week.isDeload ? ' · deload' : ''}`}
        action={
          <div className="flex gap-1">
            <Button small tone="subtle" disabled={wi === 0} onClick={() => setWeekIdx(wi - 1)}>
              ‹
            </Button>
            <Button small tone="subtle" disabled={wi === plan.weeks.length - 1} onClick={() => setWeekIdx(wi + 1)}>
              ›
            </Button>
          </div>
        }
      >
        <Card className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">{fmtDate(week.startDate, { day: 'numeric', month: 'short' })} – {fmtDate(addDays(week.startDate, 6), { day: 'numeric', month: 'short' })}</span>
            {week.validated ? <Badge cls="bg-ok/15 text-ok">Validated</Badge> : <Badge cls="bg-warn/15 text-warn">Not validated</Badge>}
          </div>
          {week.caps && (
            <div className="text-xs text-muted">
              Finger load est. {fmtNum(week.caps.estFinger, 0)} / cap {fmtNum(week.caps.finger, 0)} FLU · restricted grips {fmtNum(week.caps.estRestricted, 0)} / {fmtNum(week.caps.restricted, 0)}
            </div>
          )}
          <p className="text-xs text-muted">Long-press a session and drag it to another day. Tap to edit.</p>
          <WeekBoard week={week} plan={plan} onPlan={onPlan} onOpen={setEditing} />
          {violations.length > 0 && (
            <div className="text-sm text-warn space-y-1">
              {violations.map((v) => (
                <div key={v.sessionId + v.rule}>⚠ {v.message}</div>
              ))}
            </div>
          )}
          {(week.notes ?? []).length > 0 && (
            <details className="text-xs text-muted">
              <summary>Generator notes ({week.notes!.length})</summary>
              <ul className="list-disc pl-5 mt-1 space-y-0.5">
                {week.notes!.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <Button tone="ghost" className="flex-1" onClick={() => setDayMenu(true)}>
              Days off / outdoor
            </Button>
            {!week.validated && (
              <Button className="flex-1" onClick={() => void run(() => svc.validateWeek(week.id), 'Week validated')}>
                Validate week
              </Button>
            )}
          </div>
          {plan.status === 'draft' && (
            <Button tone="subtle" className="w-full" onClick={() => void run(() => svc.validateAllWeeks(), 'Block validated')}>
              Validate whole block
            </Button>
          )}
        </Card>
      </Section>

      {proj && projSeries.length > 0 && (
        <Section title="Projected finger ACWR">
          <Card>
            <LineChart
              labels={projSeries.map((p) => p.date.slice(5))}
              series={[{ name: 'Finger ACWR', color: 'rgb(var(--accent))', values: projSeries.map((p) => p.ratio) }]}
              bands={[
                { from: 0.8, to: 1.3, color: 'rgba(34,197,94,0.10)' },
                { from: 1.3, to: 1.5, color: 'rgba(245,158,11,0.12)' },
                { from: 1.5, to: 3, color: 'rgba(239,68,68,0.10)' },
              ]}
              yMin={0}
              yMax={2}
              marker={projSeries.findIndex((p) => p.date > d.today) - 1}
            />
            <p className="text-xs text-muted mt-1">{proj.finger.calibrating ? 'Calibrating: projection indicative only.' : proj.warning ? 'Planned load would leave the green zone — consider moving or lightening a session.' : 'Planned load stays within limits.'}</p>
          </Card>
        </Section>
      )}

      <Button tone="ghost" className="w-full" onClick={() => confirmAction('Regenerate the plan from your latest profile and benchmarks? Your edits to future sessions will be replaced (history is kept).') && void run(() => svc.generatePlan('Regenerated by user'), 'Plan regenerated (draft)')}>
        Regenerate plan
      </Button>

      {editing && <SessionEditor sessionId={editing} plan={plan} onClose={() => setEditing(null)} onPlan={onPlan} />}

      <Sheet open={dayMenu} onClose={() => setDayMenu(false)} title="Availability this week">
        <div className="space-y-2">
          {Array.from({ length: 7 }, (_, i) => addDays(week.startDate, i)).map((dt) => (
            <div key={dt} className="flex items-center justify-between gap-2 min-h-[44px]">
              <span>{fmtDate(dt)}</span>
              <div className="flex gap-1">
                <Button small tone={week.unavailableDays.includes(dt) ? 'danger' : 'subtle'} onClick={() => onPlan(toggleDayFlag(plan, dt, 'unavailable', !week.unavailableDays.includes(dt)), `${dt} marked ${week.unavailableDays.includes(dt) ? 'available' : 'unavailable'}`)}>
                  Busy
                </Button>
                <Button small tone={week.outdoorDays.includes(dt) ? 'primary' : 'subtle'} onClick={() => onPlan(toggleDayFlag(plan, dt, 'outdoor', !week.outdoorDays.includes(dt)), `${dt} ${week.outdoorDays.includes(dt) ? 'no longer' : ''} outdoor`)}>
                  Outdoor
                </Button>
              </div>
            </div>
          ))}
          <Button className="w-full mt-2" onClick={() => void run(async () => { await svc.rebuildWeek(week.id); setDayMenu(false); }, 'Week rebuilt — check and validate')}>
            Rebuild week around these days
          </Button>
        </div>
      </Sheet>

      <Sheet open={historyOpen} onClose={() => setHistoryOpen(false)} title="Plan history">
        {versions.length === 0 ? (
          <Empty>No history yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {versions.map((v) => (
              <li key={v.id} className="border border-line rounded-xl p-3">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">v{v.version}</span>
                  <span className="text-muted">
                    {fmtDate(v.date)} · {v.actor}
                  </span>
                </div>
                <div className="text-sm text-muted">{v.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </div>
  );
}
