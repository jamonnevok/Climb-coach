/**
 * SETTINGS: profile (dated history), training capacity & schedule, goal / target date,
 * modes (normal / low capacity / newborn), assessment (questionnaire, weakness ranking,
 * cold-start week), exercise library & custom builder, appearance, reminders, Tindeq, data.
 */
import { useState } from 'react';
import { exerciseLibrary } from '../../config';
import { SCHEMA_VERSION } from '../../data/schema';
import type { CustomExercise, ExerciseCategory, FingerIntensity, Grip, LoadMode, ProfileEntry, QuestionId, Scale5, TimerKind, TrainingMode } from '../../data/schema';
import { QUESTIONS, QUESTIONNAIRE_DEFAULTS } from '../../engine/assessment';
import { buildColdStartSeed, SUGGESTED_COLD_START, validateColdStart, type ColdStartInput } from '../../engine/coldStart';
import { FONT_GRADES, SPORT_GRADES } from '../../lib/grades';
import { requestPermission } from '../../app/reminders';
import { useStore } from '../store';
import { GRIP_LABELS, fmtDate } from '../format';
import { Badge, Button, Card, EvidenceBadge, Field, NumberInput, ReferenceList, Scale5Input, Section, Segmented, Sheet, Stepper, Toggle, confirmAction } from '../components/ui';
import { TindeqConnect } from './Session';
import { DataSection } from './settings/DataSection';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function DayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="flex gap-1">
      {DAYS.map((d, i) => (
        <button key={d} type="button" onClick={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i].sort())} className={`flex-1 h-10 rounded-lg text-sm ${value.includes(i) ? 'bg-accent text-black font-semibold' : 'bg-line/50 text-muted'}`}>
          {d}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Profile ---------------- */

export function ProfileForm({ onSaved }: { onSaved?: () => void }) {
  const { d, svc, run } = useStore();
  const [p, setP] = useState<ProfileEntry>(d.profile);
  const set = <K extends keyof ProfileEntry>(k: K, v: ProfileEntry[K]) => setP({ ...p, [k]: v });
  const sport = SPORT_GRADES.filter((g) => g >= '5');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Body mass (kg)">
          <NumberInput value={p.bodyMassKg} onChange={(v) => set('bodyMassKg', v ?? p.bodyMassKg)} step={0.1} />
        </Field>
        <Field label="Height (cm)">
          <NumberInput value={p.heightCm} onChange={(v) => set('heightCm', v ?? p.heightCm)} />
        </Field>
        <Field label="Birth year">
          <NumberInput value={p.birthYear} onChange={(v) => set('birthYear', v ?? p.birthYear)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Sport redpoint">
          <select value={p.gradeSportRedpoint} onChange={(e) => set('gradeSportRedpoint', e.target.value)}>
            {sport.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Sport onsight">
          <select value={p.gradeSportOnsight} onChange={(e) => set('gradeSportOnsight', e.target.value)}>
            {sport.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Boulder outdoor">
          <select value={p.gradeBoulderOutdoor} onChange={(e) => set('gradeBoulderOutdoor', e.target.value)}>
            {FONT_GRADES.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        <Field label={`Boulder ${p.boardName}`}>
          <select value={p.gradeBoulderBoard} onChange={(e) => set('gradeBoulderBoard', e.target.value)}>
            {FONT_GRADES.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Goal (redpoint)">
          <select value={p.goal.grade} onChange={(e) => set('goal', { ...p.goal, grade: e.target.value })}>
            {sport.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Target date (optional)" hint="Plan built backwards with taper">
          <input type="date" value={p.goal.targetDate ?? ''} onChange={(e) => set('goal', { ...p.goal, targetDate: e.target.value || null })} />
        </Field>
      </div>
      <Field label="Years of structured training">
        <Stepper value={p.yearsStructuredTraining} onChange={(v) => set('yearsStructuredTraining', v)} min={0} />
      </Field>
      <Field label="Injury history">
        <textarea rows={2} value={p.injuryHistory} onChange={(e) => set('injuryHistory', e.target.value)} />
      </Field>
      <Button
        className="w-full"
        onClick={() =>
          void run(async () => {
            const { id: _i, createdAt: _c, updatedAt: _u, date: _d, deleted: _x, ...patch } = p;
            void _i; void _c; void _u; void _d; void _x;
            await svc.updateProfile(patch);
            onSaved?.();
          }, 'Profile saved (dated entry)')
        }
      >
        Save profile
      </Button>
    </div>
  );
}

/* ---------------- Questionnaire ---------------- */

export function QuestionnaireForm({ onSaved }: { onSaved?: () => void }) {
  const { svc, run, data } = useStore();
  const last = data.questionnaires.slice().sort((a, b) => a.date.localeCompare(b.date)).pop();
  const [a, setA] = useState<Partial<Record<QuestionId, Scale5>>>({ ...QUESTIONNAIRE_DEFAULTS, ...(last?.answers ?? {}) });
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">1 = clear weakness · 5 = clear strength. Reading, tactics and resting default to strengths.</p>
      {QUESTIONS.map((q) => (
        <Field key={q.id} label={q.text}>
          <Scale5Input value={a[q.id]} onChange={(v) => setA({ ...a, [q.id]: v })} low="Disagree" high="Agree" />
        </Field>
      ))}
      <Button className="w-full" onClick={() => void run(async () => { await svc.saveQuestionnaire(a); onSaved?.(); }, 'Questionnaire saved')}>
        Save answers
      </Button>
    </div>
  );
}

/* ---------------- Cold start ---------------- */

export function ColdStartForm({ onSaved }: { onSaved?: () => void }) {
  const { d, svc, run } = useStore();
  const cs = d.settings.coldStart;
  const [v, setV] = useState<ColdStartInput>(cs ? { ...cs } : SUGGESTED_COLD_START);
  const issues = validateColdStart(v);
  const set = <K extends keyof ColdStartInput>(k: K, x: ColdStartInput[K]) => setV({ ...v, [k]: x });
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Your typical week over the last 4 weeks. It seeds the load model so the first weeks are compared with a realistic baseline (ACWR shows “calibrating” for 4 weeks).</p>
      <Field label="Sessions per week">
        <Stepper value={v.sessionsPerWeek} onChange={(x) => set('sessionsPerWeek', x)} min={0} max={14} />
      </Field>
      <Field label="Average duration (min)">
        <Stepper value={v.avgDurationMin} onChange={(x) => set('avgDurationMin', x)} step={5} min={0} />
      </Field>
      <Field label="Average session RPE (0-10)">
        <Stepper value={v.avgSessionRPE} onChange={(x) => set('avgSessionRPE', x)} min={0} max={10} />
      </Field>
      <Field label="Sessions with finger work per week">
        <Stepper value={v.fingerSessionsPerWeek} onChange={(x) => set('fingerSessionsPerWeek', x)} min={0} max={14} />
      </Field>
      <Field label="Minutes actually on holds/hangboard per finger session" hint="Time under finger load, not session length (typ. 8-20 min).">
        <Stepper value={v.fingerMinutesPerSession} onChange={(x) => set('fingerMinutesPerSession', x)} min={0} max={120} />
      </Field>
      <Field label="Typical finger intensity">
        <Segmented value={v.fingerIntensity} onChange={(x) => set('fingerIntensity', x)} options={[{ value: 'low', label: 'Low' }, { value: 'moderate', label: 'Moderate' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }]} />
      </Field>
      {issues.map((i) => (
        <p key={i.field} className="text-xs text-bad">{i.message}</p>
      ))}
      <Button className="w-full" disabled={issues.length > 0} onClick={() => void run(async () => { await svc.updateSettings({ coldStart: buildColdStartSeed(v, cs?.seededAt ?? d.today) }); onSaved?.(); }, 'Baseline week saved')}>
        Save
      </Button>
    </div>
  );
}

/* ---------------- Custom exercise builder ---------------- */

const CATS: ExerciseCategory[] = ['finger', 'pull', 'core', 'power', 'technique', 'endurance', 'prehab', 'antagonist', 'climbing', 'warmup', 'cooldown'];
const TIMERS: TimerKind[] = ['hang', 'repeaters', 'isometric', 'reps', 'interval', 'emom', 'four_by_four', 'arc', 'countdown'];
const LOADS: LoadMode[] = ['added_kg', 'removed_kg', 'target_force_kg', 'percent_bw', 'bodyweight', 'grade', 'none'];
const FI: FingerIntensity[] = ['none', 'low', 'moderate', 'high', 'max'];

function CustomExerciseSheet({ onClose, existing }: { onClose: () => void; existing?: CustomExercise }) {
  const { svc, run } = useStore();
  const [e, setE] = useState({
    name: existing?.name ?? '',
    category: existing?.category ?? ('finger' as ExerciseCategory),
    timer: existing?.timer ?? { kind: 'hang' as TimerKind, sets: 3, reps: 1, workS: 10, restS: 0, setRestS: 120 },
    loadMode: existing?.loadMode ?? ('added_kg' as LoadMode),
    defaultGrip: existing?.defaultGrip ?? ('half_crimp' as Grip),
    edgeMm: existing?.edgeMm ?? 20,
    fingerIntensity: existing?.fingerIntensity ?? ('high' as FingerIntensity),
    rationale: existing?.rationale ?? '',
  });
  const t = e.timer;
  return (
    <Sheet open onClose={onClose} title={existing ? 'Edit exercise' : 'New exercise'}>
      <div className="space-y-3">
        <Field label="Name">
          <input value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Type">
            <select value={e.category} onChange={(x) => setE({ ...e, category: x.target.value as ExerciseCategory })}>
              {CATS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Timer pattern">
            <select value={t.kind} onChange={(x) => setE({ ...e, timer: { ...t, kind: x.target.value as TimerKind } })}>
              {TIMERS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Load unit">
            <select value={e.loadMode} onChange={(x) => setE({ ...e, loadMode: x.target.value as LoadMode })}>
              {LOADS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Grip">
            <select value={e.defaultGrip} onChange={(x) => setE({ ...e, defaultGrip: x.target.value as Grip })}>
              {(Object.keys(GRIP_LABELS) as Grip[]).map((g) => <option key={g} value={g}>{GRIP_LABELS[g]}</option>)}
            </select>
          </Field>
          <Field label="Finger intensity">
            <select value={e.fingerIntensity} onChange={(x) => setE({ ...e, fingerIntensity: x.target.value as FingerIntensity })}>
              {FI.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Edge (mm)">
            <NumberInput value={e.edgeMm} onChange={(v) => setE({ ...e, edgeMm: v ?? 20 })} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Sets"><NumberInput value={t.sets} onChange={(v) => setE({ ...e, timer: { ...t, sets: v ?? 1 } })} /></Field>
          <Field label="Reps"><NumberInput value={t.reps} onChange={(v) => setE({ ...e, timer: { ...t, reps: v ?? 1 } })} /></Field>
          <Field label="Work s"><NumberInput value={t.workS} onChange={(v) => setE({ ...e, timer: { ...t, workS: v ?? 0 } })} /></Field>
          <Field label="Rest s"><NumberInput value={t.restS} onChange={(v) => setE({ ...e, timer: { ...t, restS: v ?? 0 } })} /></Field>
          <Field label="Set rest s"><NumberInput value={t.setRestS} onChange={(v) => setE({ ...e, timer: { ...t, setRestS: v ?? 0 } })} /></Field>
          <Field label="Total s"><NumberInput value={t.totalS ?? null} onChange={(v) => setE({ ...e, timer: { ...t, totalS: v ?? undefined } })} /></Field>
        </div>
        <Field label="Rationale (shown in sessions)">
          <textarea rows={2} value={e.rationale} onChange={(x) => setE({ ...e, rationale: x.target.value })} />
        </Field>
        <p className="text-xs text-muted">Custom exercises are labelled “coaching practice”.</p>
        <Button
          className="w-full"
          disabled={!e.name}
          onClick={() =>
            void run(async () => {
              await svc.saveCustomExercise({ ...(existing ?? {}), ...e, equipment: [], references: [], evidence: 'coaching_practice', custom: true });
              onClose();
            }, 'Exercise saved')
          }
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}

function Library() {
  const { d, data, svc, run } = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [builder, setBuilder] = useState<CustomExercise | 'new' | null>(null);
  const all = [...d.lib.values()].filter((e) => e.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input placeholder="Search library…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button onClick={() => setBuilder('new')}>New</Button>
      </div>
      <p className="text-xs text-muted">{exerciseLibrary.length} built-in exercises (src/config/exercises.json) + {data.customExercises.length} custom.</p>
      {all.map((e) => (
        <div key={e.id} className="border border-line rounded-xl">
          <button className="w-full text-left p-3 flex justify-between gap-2" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <span>{e.name}</span>
            <span className="flex gap-1">{e.custom && <Badge>Custom</Badge>}<EvidenceBadge level={e.evidence} /></span>
          </button>
          {open === e.id && (
            <div className="p-3 pt-0 space-y-2 text-sm">
              <p>{e.rationale}</p>
              <ReferenceList ids={e.references} />
              {e.custom && (
                <div className="flex gap-2">
                  <Button small tone="ghost" onClick={() => setBuilder(data.customExercises.find((c) => c.id === e.id) ?? null)}>Edit</Button>
                  <Button small tone="ghost" onClick={() => confirmAction('Delete this exercise?') && void run(() => svc.softDelete('customExercises', e.id), 'Deleted')}>Delete</Button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {builder && <CustomExerciseSheet onClose={() => setBuilder(null)} existing={builder === 'new' ? undefined : builder} />}
    </div>
  );
}

/* ---------------- Page ---------------- */

type Panel = null | 'profile' | 'questionnaire' | 'coldstart' | 'library';

export function SettingsPage() {
  const { d, data, svc, run } = useStore();
  const s = d.settings;
  const [panel, setPanel] = useState<Panel>(null);
  const history = data.profile.slice().sort((a, b) => b.date.localeCompare(a.date));
  const modeOptions: { value: TrainingMode; label: string }[] = [
    { value: 'normal', label: 'Normal' },
    { value: 'low_capacity', label: 'Low capacity' },
    { value: 'newborn', label: 'Newborn' },
  ];
  const remind = (k: keyof typeof s.reminders, v: string | null) =>
    void run(async () => {
      if (v) await requestPermission();
      await svc.updateSettings({ reminders: { ...s.reminders, [k]: v } });
    }, 'Saved');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Section title="Profile" action={<button className="text-sm text-accent" onClick={() => setPanel('profile')}>Edit</button>}>
        <Card className="text-sm space-y-1">
          <div>{d.profile.bodyMassKg} kg · {d.profile.heightCm} cm · {new Date().getFullYear() - d.profile.birthYear} y</div>
          <div className="text-muted">
            Sport {d.profile.gradeSportRedpoint} RP / {d.profile.gradeSportOnsight} OS · boulder {d.profile.gradeBoulderOutdoor} outdoor / {d.profile.gradeBoulderBoard} {d.profile.boardName}
          </div>
          <div className="text-muted">Goal {d.profile.goal.grade} redpoint{d.profile.goal.targetDate ? ` by ${fmtDate(d.profile.goal.targetDate)}` : ' (no target date)'}</div>
          <details className="text-xs text-muted">
            <summary>History ({history.length})</summary>
            {history.map((p) => (
              <div key={p.id}>{p.date}: {p.bodyMassKg} kg · {p.gradeSportRedpoint} · goal {p.goal.grade}</div>
            ))}
          </details>
        </Card>
      </Section>

      <Section title="Training">
        <Card className="space-y-4">
          <Field label="Sessions per week">
            <Stepper value={s.sessionsPerWeek} onChange={(v) => void run(() => svc.updateSettings({ sessionsPerWeek: v }))} min={1} max={4} />
          </Field>
          <Field label="Preferred days">
            <DayPicker value={s.preferredDays} onChange={(v) => void run(() => svc.updateSettings({ preferredDays: v }))} />
          </Field>
          <Field label="Never available">
            <DayPicker value={s.unavailableWeekdays} onChange={(v) => void run(() => svc.updateSettings({ unavailableWeekdays: v }))} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Weekday session (min)">
              <NumberInput value={s.weekdaySessionMin} onChange={(v) => void run(() => svc.updateSettings({ weekdaySessionMin: v ?? 90 }))} step={5} />
            </Field>
            <Field label="Weekend session (min)">
              <NumberInput value={s.weekendSessionMin} onChange={(v) => void run(() => svc.updateSettings({ weekendSessionMin: v ?? 180 }))} step={15} />
            </Field>
          </div>
          <p className="text-xs text-muted">Changes apply when you regenerate the plan (Plan → Regenerate).</p>
        </Card>
      </Section>

      <Section title="Mode">
        <Card className="space-y-3">
          <Segmented
            value={s.mode === 'return_ramp' ? 'normal' : s.mode}
            onChange={(m) => m !== s.mode && confirmAction(`Switch to ${m.replace('_', ' ')} mode and regenerate the plan?`) && void run(() => svc.setMode(m), 'Mode changed')}
            options={modeOptions}
          />
          {s.mode === 'return_ramp' && <p className="text-sm text-accent">Return ramp active (60 → 75 → 90 % volume), back to normal automatically.</p>}
          <p className="text-xs text-muted">
            Newborn: 2 home sessions/week of 30-40 min (hangboard, no-hang, loading pin, Tindeq), climbing as optional bonus, readiness thresholds adjusted for fragmented sleep. Low capacity: 2 × 60 min maintenance.
          </p>
          <Field label="Suggest newborn mode from">
            <input type="date" value={s.newbornSuggestFrom ?? ''} onChange={(e) => void run(() => svc.updateSettings({ newbornSuggestFrom: e.target.value || null }))} />
          </Field>
        </Card>
      </Section>

      <Section title="Assessment">
        <Card className="space-y-3">
          <div className="text-sm font-semibold">Weakness ranking (weakest first)</div>
          <ol className="space-y-1 text-sm">
            {d.ranking.ranked.map((r, i) => (
              <li key={r.domain} className="flex justify-between gap-2">
                <span>{i + 1}. {r.label}</span>
                <span className="text-muted">{r.score} · {r.confidence}</span>
              </li>
            ))}
          </ol>
          <details className="text-xs text-muted">
            <summary>Why</summary>
            {d.ranking.ranked.flatMap((r) => r.notes.map((n) => <div key={r.domain + n}>• {n}</div>))}
          </details>
          <p className="text-xs text-muted">{d.ranking.caveat}</p>
          <div className="flex gap-2">
            <Button small tone="ghost" onClick={() => setPanel('questionnaire')}>Questionnaire</Button>
            <Button small tone="ghost" onClick={() => setPanel('coldstart')}>Baseline week</Button>
          </div>
        </Card>
      </Section>

      <Section title="Exercise library" action={<button className="text-sm text-accent" onClick={() => setPanel('library')}>Open</button>}>
        <Card className="text-sm text-muted">Browse rationale and references; build custom exercises (name, type, timer, load unit, grip).</Card>
      </Section>

      <Section title="Appearance">
        <Card className="space-y-3">
          <Segmented value={s.theme} onChange={(v) => void run(() => svc.updateSettings({ theme: v }))} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
          <div className="flex gap-2">
            {['#22d3ee', '#a3e635', '#f59e0b', '#f472b6', '#818cf8'].map((c) => (
              <button key={c} aria-label={c} onClick={() => void run(() => svc.updateSettings({ accent: c }))} className={`w-10 h-10 rounded-full ${s.accent === c ? 'ring-2 ring-offset-2 ring-offset-card ring-fg' : ''}`} style={{ background: c }} />
            ))}
          </div>
        </Card>
      </Section>

      <Section title="Reminders">
        <Card className="space-y-3">
          {(
            [
              ['morningCheckin', 'Morning check-in', '07:30'],
              ['sessionReminder', 'Session day', '17:00'],
              ['weeklyReview', 'Sunday weekly review', '19:00'],
            ] as const
          ).map(([k, label, def]) => (
            <div key={k} className="flex items-center gap-2">
              <div className="flex-1">
                <Toggle checked={s.reminders[k] !== null} onChange={(on) => remind(k, on ? def : null)} label={label} />
              </div>
              {s.reminders[k] !== null && <input type="time" className="w-28" value={s.reminders[k] ?? ''} onChange={(e) => remind(k, e.target.value)} />}
            </div>
          ))}
          <p className="text-xs text-muted">Reminders fire while the app is open or running in the background (no server, no cost).</p>
        </Card>
      </Section>

      <Section title="Tindeq Progressor">
        <Card className="space-y-2">
          <TindeqConnect />
          {s.tindeq.deviceName && <p className="text-xs text-muted">Remembered: {s.tindeq.deviceName}. Do not pair it in Android Bluetooth settings — connect from the app.</p>}
        </Card>
      </Section>

      <DataSection />

      <Section title="Setup">
        <Card className="space-y-2">
          <Button tone="ghost" className="w-full" onClick={() => { location.hash = '#/onboarding'; }}>
            Re-run onboarding
          </Button>
          <p className="text-xs text-muted">Climb Coach v1 · schema v{SCHEMA_VERSION} · rule-based, offline, free.</p>
        </Card>
      </Section>

      <Sheet open={panel === 'profile'} onClose={() => setPanel(null)} title="Profile">
        <ProfileForm onSaved={() => setPanel(null)} />
      </Sheet>
      <Sheet open={panel === 'questionnaire'} onClose={() => setPanel(null)} title="Self-assessment">
        <QuestionnaireForm onSaved={() => setPanel(null)} />
      </Sheet>
      <Sheet open={panel === 'coldstart'} onClose={() => setPanel(null)} title="Typical week (last 4 weeks)">
        <ColdStartForm onSaved={() => setPanel(null)} />
      </Sheet>
      <Sheet open={panel === 'library'} onClose={() => setPanel(null)} title="Exercise library">
        <Library />
      </Sheet>
    </div>
  );
}
