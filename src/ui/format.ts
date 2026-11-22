/** Display helpers (labels, units, colours). Metric only. */
import type { AcwrZone } from '../engine/load';
import type { BlockKind, ExerciseDef, Grip, LoadMode, PlannedItem, SessionKind, TimerPattern } from '../data/schema';
import { parseISODate, type ISODate } from '../lib/dates';
import type { PainLight } from '../engine/pain';

export const GRIP_LABELS: Record<Grip, string> = {
  half_crimp: 'Half crimp',
  open_hand: 'Open hand',
  full_crimp: 'Full crimp',
  pocket_2f_front: '2F pocket (index-middle)',
  pocket_2f_middle: '2F pocket (middle-ring)',
  pocket_3f: '3F pocket',
  mono: 'Mono',
  pinch: 'Pinch',
  sloper: 'Sloper',
  jug: 'Jug',
  mixed: 'Mixed',
};

export const SESSION_KIND_LABELS: Record<SessionKind, string> = {
  training: 'Training',
  technique: 'Technique',
  free: 'Free climbing',
  projecting: 'Projecting',
  outdoor: 'Outdoor',
  other_sport: 'Other sport',
  prehab: 'Prehab',
  test: 'Test',
};

export const BLOCK_LABELS: Record<BlockKind, string> = {
  strength: 'Strength',
  power: 'Power',
  power_endurance: 'Power endurance',
  performance: 'Performance',
  projecting: 'Projecting',
  maintenance: 'Maintenance',
  newborn: 'Newborn',
  return_ramp: 'Return ramp',
  taper: 'Taper',
};

export const BLOCK_COLORS: Record<BlockKind, string> = {
  strength: 'bg-sky-500',
  power: 'bg-violet-500',
  power_endurance: 'bg-amber-500',
  performance: 'bg-amber-500',
  projecting: 'bg-emerald-500',
  maintenance: 'bg-zinc-500',
  newborn: 'bg-pink-500',
  return_ramp: 'bg-teal-500',
  taper: 'bg-lime-500',
};

export const ZONE_STYLE: Record<AcwrZone, { label: string; cls: string }> = {
  none: { label: 'No data', cls: 'bg-line text-muted' },
  calibrating: { label: 'Calibrating', cls: 'bg-sky-500/15 text-sky-400' },
  low: { label: 'Low', cls: 'bg-sky-500/15 text-sky-400' },
  green: { label: 'Green', cls: 'bg-ok/15 text-ok' },
  orange: { label: 'Orange', cls: 'bg-warn/15 text-warn' },
  red: { label: 'Red', cls: 'bg-bad/15 text-bad' },
};

export const PAIN_STYLE: Record<PainLight, { label: string; cls: string; dot: string }> = {
  green: { label: 'Continue', cls: 'bg-ok/15 text-ok', dot: 'bg-ok' },
  amber: { label: 'Modify', cls: 'bg-warn/15 text-warn', dot: 'bg-warn' },
  red: { label: 'Stop', cls: 'bg-bad/15 text-bad', dot: 'bg-bad' },
  red_flag: { label: 'See a physio', cls: 'bg-bad text-white', dot: 'bg-bad' },
};

export function fmtDate(d: ISODate, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  return parseISODate(d).toLocaleDateString('en-GB', opts);
}

export function fmtDay(d: ISODate): string {
  return parseISODate(d).toLocaleDateString('en-GB', { weekday: 'short' });
}

export const fmtNum = (x: number | null | undefined, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : String(Math.round(x * 10 ** digits) / 10 ** digits));

export function fmtLoad(mode: LoadMode, value: number | null, bodyMassKg?: number): string {
  if (value === null) {
    if (mode === 'bodyweight') return 'BW';
    if (mode === 'none' || mode === 'grade') return '';
    return 'set load';
  }
  const pct = (kg: number) => (bodyMassKg ? ` (${Math.round((kg / bodyMassKg) * 100)} % BW)` : '');
  switch (mode) {
    case 'added_kg':
      return value >= 0 ? `+${value} kg${pct(value)}` : `${value} kg assisted${pct(value)}`;
    case 'removed_kg':
      return `−${value} kg removed${pct(-value)}`;
    case 'percent_bw':
      return `${value >= 0 ? '+' : ''}${value} % BW`;
    case 'target_force_kg':
      return `target ${value} kg`;
    case 'bodyweight':
      return 'BW';
    default:
      return String(value);
  }
}

export function fmtTimer(t: TimerPattern): string {
  switch (t.kind) {
    case 'repeaters':
      return `${t.sets} × ${t.reps} × ${t.workS}:${t.restS}`;
    case 'hang':
    case 'isometric':
      return `${t.sets} × ${t.reps > 1 ? `${t.reps} × ` : ''}${t.workS} s`;
    case 'reps':
      return `${t.sets} × ${t.reps}`;
    case 'interval':
    case 'emom':
      return `${t.reps} × ${t.workS}/${t.restS} s`;
    case 'four_by_four':
      return `${t.sets} × ${t.reps} problems`;
    case 'arc':
    case 'countdown':
      return `${Math.round((t.totalS ?? 0) / 60)} min`;
    default:
      return '';
  }
}

export function itemSummary(item: PlannedItem, ex: ExerciseDef | undefined, bodyMassKg: number): string {
  const parts = [fmtTimer(item.timer), fmtLoad(item.load.mode, item.load.value, bodyMassKg)];
  if (item.grip && ex?.fingerIntensity !== 'none' && item.grip !== 'mixed') parts.push(GRIP_LABELS[item.grip]);
  if (item.edgeMm && ex?.category === 'finger') parts.push(`${item.edgeMm} mm`);
  return parts.filter(Boolean).join(' · ');
}

export function hexToRgbTriplet(hex: string): string {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return '34 211 238';
  return `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}`;
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
