/**
 * CSV EXPORT for Excel: semicolon separators, UTF-8 with BOM, optional decimal comma
 * (default ON — matches Belgian/French Excel). All tables are bundled in one .zip
 * (stored, no compression — dependency-free writer below).
 */
import { addDays, startOfWeek } from '../lib/dates';
import type { Snapshot } from '../data/schema';

export interface CsvOptions {
  decimalComma: boolean;
}

type Cell = string | number | boolean | null | undefined;

export function cell(v: Cell, o: CsvOptions): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'number') s = Number.isFinite(v) ? (o.decimalComma ? String(v).replace('.', ',') : String(v)) : '';
  else if (typeof v === 'boolean') s = v ? '1' : '0';
  else s = v;
  return /[;"\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][], o: CsvOptions): string {
  return '\uFEFF' + [header, ...rows].map((r) => r.map((c) => cell(c, o)).join(';')).join('\r\n') + '\r\n';
}

const live = <T extends { deleted?: boolean }>(xs: T[]) => xs.filter((x) => !x.deleted);
const byDate = <T extends { date: string }>(xs: T[]) => [...xs].sort((a, b) => a.date.localeCompare(b.date));

export function buildCsvFiles(s: Snapshot, o: CsvOptions): Record<string, string> {
  const st = s.stores;
  const sessions = byDate(live(st.sessions));
  const files: Record<string, string> = {};

  files['sessions.csv'] = toCsv(
    ['date', 'type', 'duration_min', 'session_rpe', 'global_load_au', 'finger_load_flu', 'restricted_grip_flu', 'location', 'source', 'sets', 'other_sport', 'notes', 'id'],
    sessions.map((x) => [x.date, x.kind, x.durationMin, x.sessionRPE, x.globalLoad, x.fingerLoad, x.restrictedGripLoad, x.location, x.source, x.sets.length, x.otherSportName, x.notes, x.id]),
    o,
  );

  files['sets.csv'] = toCsv(
    ['date', 'session_id', 'exercise', 'set', 'completed', 'reps', 'work_s', 'load_mode', 'load_kg', 'grip', 'edge_mm', 'hand', 'rpe', 'finger_feeling', 'peak_force_kg', 'ended_by_force_drop'],
    sessions.flatMap((x) =>
      x.sets.map((z) => [x.date, x.id, z.exerciseId, z.setIndex + 1, z.completed, z.reps, z.workS, z.load.mode, z.load.value, z.grip, z.edgeMm, z.hand, z.rpe, z.fingerFeeling, z.peakForceKg, z.endedByForceDrop ?? false]),
    ),
    o,
  );

  files['climbs.csv'] = toCsv(
    ['date', 'discipline', 'grade', 'style', 'attempts', 'setting', 'board', 'board_angle_deg', 'angle', 'rock', 'grips', 'name', 'session_id'],
    byDate(live(st.climbs)).map((c) => [c.date, c.discipline, c.grade, c.style, c.attempts, c.setting, c.board, c.boardAngleDeg, c.angle, c.rock, c.grips.join(','), c.name, c.sessionLogId]),
    o,
  );

  files['checkins.csv'] = toCsv(
    ['date', 'sleep_quality', 'fatigue', 'soreness', 'stress', 'motivation', 'finger_status', 'notes'],
    byDate(live(st.checkins)).map((c) => [c.date, c.sleepQuality, c.fatigue, c.soreness, c.stress, c.motivation, c.fingerStatus, c.notes]),
    o,
  );

  files['sleep.csv'] = toCsv(
    ['date', 'source', 'duration_h', 'quality', 'sleep_score', 'resting_hr', 'hrv_ms', 'body_battery_high'],
    byDate(live(st.sleep)).map((x) => [x.date, x.source, x.durationH, x.quality, x.sleepScore, x.restingHr, x.hrvMs, x.bodyBatteryHigh]),
    o,
  );

  files['benchmarks.csv'] = toCsv(
    ['date', 'test', 'value', 'unit', 'hand', 'reps', 'reps_to_failure', 'grade', 'body_mass_kg', 'pct_bw', 'source', 'notes'],
    byDate(live(st.benchmarks)).map((b) => {
      const pct =
        b.unit === 'kg_added' ? Math.round(((b.bodyMassKg + b.value) / b.bodyMassKg) * 1000) / 10 : b.unit === 'kg_removed' ? Math.round((b.value / b.bodyMassKg) * 1000) / 10 : undefined;
      return [b.date, b.type, b.value, b.unit, b.hand, b.reps, b.repsToFailure, b.gradeText, b.bodyMassKg, pct, b.source, b.notes];
    }),
    o,
  );

  files['pain.csv'] = toCsv(
    ['date', 'time', 'region', 'side', 'finger', 'structure', 'moment', 'pain_0_10', 'red_flags', 'aggravating_grip', 'notes'],
    byDate(live(st.pain)).map((p) => {
      const l = p.location;
      return [p.date, p.at.slice(11, 16), l.region, l.side, 'finger' in l ? l.finger : undefined, l.region === 'finger' ? l.structure : undefined, p.moment, p.pain, p.redFlags.join(','), p.aggravatingGrip, p.notes];
    }),
    o,
  );

  // Weekly load (Monday-based), straight sums of the cached per-session loads.
  const weeks = new Map<string, { g: number; f: number; r: number; n: number; min: number }>();
  for (const x of sessions) {
    const w = startOfWeek(x.date);
    const cur = weeks.get(w) ?? { g: 0, f: 0, r: 0, n: 0, min: 0 };
    cur.g += x.globalLoad;
    cur.f += x.fingerLoad;
    cur.r += x.restrictedGripLoad;
    cur.n += 1;
    cur.min += x.durationMin;
    weeks.set(w, cur);
  }
  files['weekly_load.csv'] = toCsv(
    ['week_start', 'week_end', 'sessions', 'minutes', 'global_load_au', 'finger_load_flu', 'restricted_grip_flu'],
    [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([w, v]) => [w, addDays(w, 6), v.n, v.min, Math.round(v.g), Math.round(v.f * 10) / 10, Math.round(v.r * 10) / 10]),
    o,
  );
  return files;
}

/* ---------------- minimal ZIP writer (stored) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a .zip (no compression) from text files. Returns the bytes. */
export function zipFiles(files: Record<string, string>, date: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameB.length, true);
    lh.setUint16(28, 0, true);
    const local = concat([new Uint8Array(lh.buffer), nameB, data]);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(concat([new Uint8Array(ch.buffer), nameB]));
    locals.push(local);
    offset += local.length;
  }
  const central = concat(centrals);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, centrals.length, true);
  end.setUint16(10, centrals.length, true);
  end.setUint32(12, central.length, true);
  end.setUint32(16, offset, true);
  return concat([...locals, central, new Uint8Array(end.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
