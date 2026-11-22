/** Data-entry sheets: check-in, sleep, quick log, climb, benchmark, pain. */
import { useState } from 'react';
import { RED_FLAG_LABELS } from '../../engine/pain';
import { FRONT_LEVER_LEVELS, type Angle, type BenchmarkType, type BodyLocation, type ClimbLog, type Grip, type PainMoment, type RedFlag, type Scale5, type SessionKind } from '../../data/schema';
import { FONT_GRADES, SPORT_GRADES } from '../../lib/grades';
import { estimate1RMAdded } from '../../engine/assessment';
import { useStore } from '../store';
import { GRIP_LABELS, SESSION_KIND_LABELS } from '../format';
import { Button, Field, NumberInput, Scale10Input, Scale5Input, Segmented, Sheet, Stepper } from './ui';

/* ---------------- Check-in ---------------- */

export function CheckinSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { svc, run, d, data } = useStore();
  const existing = data.checkins.find((c) => c.date === d.today);
  const sleepRec = data.sleep.find((s) => s.date === d.today);
  const [v, setV] = useState({
    sleepQuality: existing?.sleepQuality ?? (3 as Scale5),
    fatigue: existing?.fatigue ?? (3 as Scale5),
    soreness: existing?.soreness ?? (4 as Scale5),
    stress: existing?.stress ?? (3 as Scale5),
    motivation: existing?.motivation ?? (4 as Scale5),
    fingerStatus: existing?.fingerStatus ?? (4 as Scale5),
  });
  const [sleepH, setSleepH] = useState<number | null>(sleepRec?.durationH ?? null);
  const set = (k: keyof typeof v) => (x: Scale5) => setV({ ...v, [k]: x });
  const save = () =>
    void run(async () => {
      await svc.saveCheckin({ date: d.today, ...v });
      if (sleepH !== null && sleepRec?.source !== 'garmin') await svc.saveSleep({ date: d.today, durationH: sleepH, quality: v.sleepQuality });
      onClose();
    }, 'Check-in saved');
  return (
    <Sheet open={open} onClose={onClose} title="Morning check-in (30 s)">
      <div className="space-y-4">
        <Field label={sleepRec?.source === 'garmin' ? `Sleep (Garmin: ${sleepRec.durationH} h)` : 'Sleep last night (h)'}>
          {sleepRec?.source === 'garmin' ? null : <NumberInput value={sleepH} onChange={setSleepH} step={0.25} min={0} max={14} placeholder="e.g. 7.25" />}
        </Field>
        <Field label="Sleep quality">
          <Scale5Input value={v.sleepQuality} onChange={set('sleepQuality')} low="Terrible" high="Great" />
        </Field>
        <Field label="Fatigue">
          <Scale5Input value={v.fatigue} onChange={set('fatigue')} low="Exhausted" high="Fresh" />
        </Field>
        <Field label="Muscle soreness">
          <Scale5Input value={v.soreness} onChange={set('soreness')} low="Very sore" high="None" />
        </Field>
        <Field label="Stress">
          <Scale5Input value={v.stress} onChange={set('stress')} low="Very stressed" high="Calm" />
        </Field>
        <Field label="Motivation">
          <Scale5Input value={v.motivation} onChange={set('motivation')} low="None" high="Psyched" />
        </Field>
        <Field label="Fingers">
          <Scale5Input value={v.fingerStatus} onChange={set('fingerStatus')} low="Painful" high="Perfect" />
        </Field>
        <Button className="w-full" onClick={save}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

/* ---------------- Sleep (manual, any date) ---------------- */

export function SleepSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { svc, run, d } = useStore();
  const [date, setDate] = useState(d.today);
  const [h, setH] = useState<number | null>(7.5);
  const [q, setQ] = useState<Scale5>(3);
  return (
    <Sheet open={open} onClose={onClose} title="Sleep">
      <div className="space-y-4">
        <Field label="Morning of">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Duration (h)">
          <NumberInput value={h} onChange={setH} step={0.25} />
        </Field>
        <Field label="Quality">
          <Scale5Input value={q} onChange={setQ} low="Terrible" high="Great" />
        </Field>
        <Button className="w-full" disabled={h === null} onClick={() => void run(async () => { await svc.saveSleep({ date, durationH: h ?? 0, quality: q }); onClose(); }, 'Sleep saved')}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

/* ---------------- Quick log (unplanned / other sport) ---------------- */

export function QuickLogSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { svc, run, d } = useStore();
  const [date, setDate] = useState(d.today);
  const [kind, setKind] = useState<SessionKind>('free');
  const [dur, setDur] = useState(90);
  const [rpe, setRpe] = useState<number | undefined>(6);
  const [sport, setSport] = useState('');
  const [fingerMin, setFingerMin] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const kinds: SessionKind[] = ['free', 'training', 'technique', 'projecting', 'outdoor', 'other_sport'];
  return (
    <Sheet open={open} onClose={onClose} title="Quick log">
      <div className="space-y-4">
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value as SessionKind)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {SESSION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'other_sport' && (
          <Field label="Sport">
            <input value={sport} onChange={(e) => setSport(e.target.value)} placeholder="e.g. running" />
          </Field>
        )}
        <Field label="Duration (min)">
          <Stepper value={dur} onChange={setDur} step={5} min={5} unit="min" />
        </Field>
        <Field label="Session RPE (0-10)" hint="How hard was the whole session? (Foster CR-10)">
          <Scale10Input value={rpe} onChange={setRpe} />
        </Field>
        {kind !== 'other_sport' && (
          <Field label="Minutes actually on holds (optional)" hint="Improves the finger-load estimate. Leave empty to estimate from climbs or session type.">
            <NumberInput value={fingerMin} onChange={setFingerMin} min={0} />
          </Field>
        )}
        <Field label="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button
          className="w-full"
          onClick={() =>
            void run(async () => {
              await svc.saveSession({
                date,
                startedAt: null,
                kind,
                durationMin: dur,
                sessionRPE: rpe ?? 5,
                location: kind === 'outdoor' ? 'outdoor' : 'gym',
                sets: [],
                climbingFingerMin: fingerMin ?? undefined,
                globalLoad: 0,
                fingerLoad: 0,
                restrictedGripLoad: 0,
                source: 'quick',
                otherSportName: kind === 'other_sport' ? sport : undefined,
                notes: notes || undefined,
              });
              onClose();
            }, 'Session logged')
          }
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}

/* ---------------- Climb ---------------- */

const ANGLES: Angle[] = ['slab', 'vertical', 'slight_overhang', 'overhang', 'steep', 'roof'];
const CLIMB_GRIPS: Grip[] = ['half_crimp', 'open_hand', 'full_crimp', 'pocket_3f', 'pocket_2f_middle', 'pocket_2f_front', 'mono', 'pinch', 'sloper', 'jug'];

export function ClimbSheet({ open, onClose, sessionLogId, date: date0 }: { open: boolean; onClose: () => void; sessionLogId?: string; date?: string }) {
  const { svc, run, d, data } = useStore();
  const last = [...data.climbs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const [c, setC] = useState<Omit<ClimbLog, 'id' | 'createdAt' | 'updatedAt'>>({
    date: date0 ?? d.today,
    sessionLogId,
    discipline: last?.discipline ?? 'route',
    grade: last?.grade ?? '7a',
    style: 'redpoint',
    angle: last?.angle ?? 'vertical',
    setting: last?.setting ?? 'outdoor',
    board: last?.board,
    rock: last?.rock ?? 'limestone',
    grips: last?.grips ?? ['half_crimp'],
    attempts: 1,
    name: '',
  });
  const grades = c.discipline === 'route' ? SPORT_GRADES.filter((g) => g >= '5') : FONT_GRADES;
  const toggleGrip = (g: Grip) => setC({ ...c, grips: c.grips.includes(g) ? c.grips.filter((x) => x !== g) : [...c.grips, g] });
  const save = (another: boolean) =>
    void run(async () => {
      await svc.saveClimb({ ...c, name: c.name || undefined });
      if (another) setC({ ...c, name: '', attempts: 1 });
      else onClose();
    }, 'Climb saved');
  return (
    <Sheet open={open} onClose={onClose} title="Add climb">
      <div className="space-y-4">
        <Segmented value={c.discipline} onChange={(v) => setC({ ...c, discipline: v, grade: v === 'route' ? '7a' : '6B', setting: v === 'route' ? 'outdoor' : c.setting })} options={[{ value: 'route', label: 'Route' }, { value: 'boulder', label: 'Boulder' }]} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Grade">
            <select value={c.grade} onChange={(e) => setC({ ...c, grade: e.target.value })}>
              {grades.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" value={c.date} onChange={(e) => setC({ ...c, date: e.target.value })} />
          </Field>
        </div>
        <Field label="Style">
          <Segmented
            value={c.style}
            onChange={(v) => setC({ ...c, style: v })}
            options={[
              { value: 'onsight', label: 'Onsight' },
              { value: 'flash', label: 'Flash' },
              { value: 'redpoint', label: c.discipline === 'route' ? 'Redpoint' : 'Send' },
              { value: 'attempt', label: 'Attempt' },
            ]}
          />
        </Field>
        <Field label={c.discipline === 'route' ? 'Burns (incl. this one)' : 'Tries (incl. this one)'}>
          <Stepper value={c.attempts} onChange={(v) => setC({ ...c, attempts: v })} min={1} />
        </Field>
        <Field label="Where">
          <Segmented
            value={c.setting}
            onChange={(v) => setC({ ...c, setting: v, board: v === 'board' ? c.board ?? 'Kilter' : undefined })}
            options={[
              { value: 'outdoor', label: 'Outdoor' },
              { value: 'indoor', label: 'Indoor' },
              { value: 'board', label: 'Board' },
            ]}
          />
        </Field>
        {c.setting === 'board' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Board">
              <select value={c.board} onChange={(e) => setC({ ...c, board: e.target.value })}>
                <option>Kilter</option>
                <option>Spray wall</option>
                <option>Other board</option>
              </select>
            </Field>
            <Field label="Angle (°)">
              <NumberInput value={c.boardAngleDeg ?? 40} onChange={(v) => setC({ ...c, boardAngleDeg: v ?? undefined })} step={5} />
            </Field>
          </div>
        )}
        {c.setting === 'outdoor' && (
          <Field label="Rock">
            <select value={c.rock} onChange={(e) => setC({ ...c, rock: e.target.value as ClimbLog['rock'] })}>
              {['limestone', 'granite', 'sandstone', 'gneiss', 'conglomerate', 'other'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Angle">
          <select value={c.angle} onChange={(e) => setC({ ...c, angle: e.target.value as Angle })}>
            {ANGLES.map((a) => (
              <option key={a} value={a}>
                {a.replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Main grips">
          <div className="flex flex-wrap gap-1">
            {CLIMB_GRIPS.map((g) => (
              <button key={g} type="button" onClick={() => toggleGrip(g)} className={`px-3 h-9 rounded-full text-sm ${c.grips.includes(g) ? 'bg-accent text-black' : 'bg-line/50 text-muted'}`}>
                {GRIP_LABELS[g]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Name (optional)">
          <input value={c.name ?? ''} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </Field>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => save(false)}>
            Save
          </Button>
          <Button tone="ghost" onClick={() => save(true)}>
            Save + another
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/* ---------------- Benchmark ---------------- */

export const BENCHMARK_META: Record<BenchmarkType, { label: string; unit: string; help: string }> = {
  max_hang_20mm_10s_hc: { label: 'Max hang 20 mm · 10 s · half crimp', unit: 'kg added', help: 'Heaviest clean 10 s hang, both hands. Negative = assisted.' },
  weighted_pullup: { label: 'Weighted pull-up', unit: 'kg added', help: 'Enter added load and reps (1 = true 1RM, 3 = 3RM → Epley estimate).' },
  repeaters_7_3_20mm: { label: 'Repeaters 7:3 to failure, 20 mm', unit: 'kg removed', help: 'Assistance (kg removed) and reps completed before failure.' },
  max_lockoff: { label: 'Max lock-off at 90°', unit: 's', help: 'Seconds held, body weight.' },
  front_lever: { label: 'Front lever level', unit: 'level', help: 'Highest progression held 5 s.' },
  power_board_max_move: { label: 'Board max (Kilter)', unit: 'grade', help: 'Hardest board problem/move this session.' },
  power_campus: { label: 'Campus max reach', unit: 'cm', help: 'Max reach on campus rungs (open hand, big rungs).' },
  tindeq_peak_force: { label: 'Tindeq peak force (per hand)', unit: 'kg', help: 'Best of 2-3 pulls, 20 mm, half crimp.' },
  tindeq_critical_force: { label: 'Critical force (per hand, optional)', unit: 'kg', help: '7:3 all-out test, mean of the last 6 reps.' },
};

export function BenchmarkSheet({ open, onClose, initialType }: { open: boolean; onClose: () => void; initialType?: BenchmarkType }) {
  const { svc, run, d } = useStore();
  const [type, setType] = useState<BenchmarkType>(initialType ?? 'max_hang_20mm_10s_hc');
  const [value, setValue] = useState<number | null>(null);
  const [reps, setReps] = useState(1);
  const [hand, setHand] = useState<'left' | 'right'>('left');
  const [grade, setGrade] = useState('7A');
  const [date, setDate] = useState(d.today);
  const meta = BENCHMARK_META[type];
  const bm = d.profile.bodyMassKg;
  const perHand = type === 'tindeq_peak_force' || type === 'tindeq_critical_force';
  const unit = { 'kg added': 'kg_added', 'kg removed': 'kg_removed', kg: 'kg', s: 's', level: 'level', cm: 'cm', grade: 'grade' }[meta.unit] as 'kg';
  const preview =
    value === null
      ? ''
      : type === 'max_hang_20mm_10s_hc'
        ? `= ${Math.round(((bm + value) / bm) * 100)} % BW total`
        : type === 'weighted_pullup'
          ? `≈ 1RM +${estimate1RMAdded(value, reps, bm)} kg (${Math.round((estimate1RMAdded(value, reps, bm) / bm) * 100)} % BW)`
          : type === 'repeaters_7_3_20mm'
            ? `= ${Math.round((value / bm) * 100)} % BW removed`
            : '';
  return (
    <Sheet open={open} onClose={onClose} title="Add benchmark">
      <div className="space-y-4">
        <Field label="Test">
          <select value={type} onChange={(e) => { setType(e.target.value as BenchmarkType); setValue(null); }}>
            {(Object.keys(BENCHMARK_META) as BenchmarkType[]).map((t) => (
              <option key={t} value={t}>
                {BENCHMARK_META[t].label}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-muted">{meta.help}</p>
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {perHand && <Segmented value={hand} onChange={setHand} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />}
        {type === 'front_lever' ? (
          <Field label="Level">
            <select value={value ?? 0} onChange={(e) => setValue(Number(e.target.value))}>
              {FRONT_LEVER_LEVELS.map((l, i) => (
                <option key={l} value={i}>
                  {l.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
        ) : type === 'power_board_max_move' ? (
          <Field label="Board grade">
            <select value={grade} onChange={(e) => { setGrade(e.target.value); setValue(0); }}>
              {FONT_GRADES.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={meta.unit} hint={preview}>
            <NumberInput value={value} onChange={setValue} step={0.5} />
          </Field>
        )}
        {(type === 'weighted_pullup' || type === 'repeaters_7_3_20mm') && (
          <Field label={type === 'weighted_pullup' ? 'Reps at that load' : 'Reps to failure'}>
            <Stepper value={reps} onChange={setReps} min={1} max={type === 'weighted_pullup' ? 5 : 60} />
          </Field>
        )}
        <Button
          className="w-full"
          disabled={value === null && type !== 'power_board_max_move'}
          onClick={() =>
            void run(async () => {
              await svc.saveBenchmark({
                date,
                type,
                value: value ?? 0,
                unit,
                bodyMassKg: bm,
                hand: perHand ? hand : 'both',
                reps: type === 'weighted_pullup' ? reps : undefined,
                repsToFailure: type === 'repeaters_7_3_20mm' ? reps : undefined,
                gradeText: type === 'power_board_max_move' ? grade : undefined,
                source: 'manual',
              });
              onClose();
            }, 'Benchmark saved')
          }
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}

/* ---------------- Pain ---------------- */

const MOMENTS: { value: PainMoment; label: string }[] = [
  { value: 'warmup', label: 'Warm-up' },
  { value: 'during', label: 'During' },
  { value: 'cooldown', label: 'Cool-down' },
  { value: 'next_morning', label: 'Next morning' },
  { value: 'rest', label: 'At rest' },
];

export function PainSheet({ open, onClose, location, sessionLogId, initialMoment = 'during' }: { open: boolean; onClose: () => void; location: BodyLocation | null; sessionLogId?: string; initialMoment?: PainMoment }) {
  const { svc, run, d } = useStore();
  const [pain, setPain] = useState<number | undefined>(2);
  const [moment, setMoment] = useState<PainMoment>(initialMoment);
  const [flags, setFlags] = useState<RedFlag[]>([]);
  const [grip, setGrip] = useState<Grip | ''>('');
  const [notes, setNotes] = useState('');
  if (!location) return null;
  const toggle = (f: RedFlag) => setFlags(flags.includes(f) ? flags.filter((x) => x !== f) : [...flags, f]);
  const where = location.region === 'finger' ? `${location.side} ${location.finger} · ${location.structure}` : `${location.side} ${location.region}`;
  return (
    <Sheet open={open} onClose={onClose} title={`Pain — ${where}`}>
      <div className="space-y-4">
        <Field label="When">
          <Segmented value={moment} onChange={setMoment} options={MOMENTS} />
        </Field>
        <Field label="Pain (0-10)" hint="≤ 2 and not worse next morning = continue · 3-5 = modify · > 5 or worsening = stop">
          <Scale10Input value={pain} onChange={setPain} danger />
        </Field>
        {location.region === 'finger' && (
          <Field label="Aggravating grip (optional)">
            <select value={grip} onChange={(e) => setGrip(e.target.value as Grip)}>
              <option value="">—</option>
              {CLIMB_GRIPS.map((g) => (
                <option key={g} value={g}>
                  {GRIP_LABELS[g]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Red flags">
          <div className="space-y-1">
            {(Object.keys(RED_FLAG_LABELS) as RedFlag[]).filter((f) => f !== 'no_improvement_2w').map((f) => (
              <label key={f} className="flex items-center gap-3 min-h-[40px]">
                <input type="checkbox" checked={flags.includes(f)} onChange={() => toggle(f)} />
                <span className="text-sm">{RED_FLAG_LABELS[f]}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Notes">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button
          className="w-full"
          onClick={() =>
            void run(async () => {
              await svc.savePain({ date: d.today, at: new Date().toISOString(), location, moment, pain: pain ?? 0, redFlags: flags, aggravatingGrip: grip || undefined, sessionLogId, notes: notes || undefined });
              onClose();
            }, flags.length ? 'Saved — red flag: see a physio before loading this again.' : 'Saved')
          }
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}
