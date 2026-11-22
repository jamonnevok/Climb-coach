/**
 * Grade ladders. Sport = French scale (lowercase, e.g. "7b+"); boulder = Fontainebleau
 * (uppercase letter from 6A, e.g. "7A+"). Index distance = number of sub-grades.
 */
const SPORT: string[] = [];
for (let n = 4; n <= 9; n++) for (const l of ['a', 'b', 'c']) for (const p of ['', '+']) SPORT.push(`${n}${l}${p}`);

const FONT: string[] = ['3', '4', '4+', '5', '5+'];
for (let n = 6; n <= 9; n++) for (const l of ['A', 'B', 'C']) for (const p of ['', '+']) FONT.push(`${n}${l}${p}`);

export const SPORT_GRADES = SPORT;
export const FONT_GRADES = FONT;

function norm(g: string) {
  return g.trim().replace(/\s+/g, '');
}

export function sportIndex(g: string): number {
  return SPORT.indexOf(norm(g).toLowerCase());
}

export function fontIndex(g: string): number {
  const s = norm(g).toUpperCase();
  return FONT.indexOf(s);
}

export function gradeIndex(g: string, discipline: 'route' | 'boulder'): number {
  return discipline === 'route' ? sportIndex(g) : fontIndex(g);
}

/** a - b in sub-grades, or null if either is unknown. */
export function gradeDelta(a: string, b: string, discipline: 'route' | 'boulder'): number | null {
  const ia = gradeIndex(a, discipline);
  const ib = gradeIndex(b, discipline);
  return ia < 0 || ib < 0 ? null : ia - ib;
}

export function shiftGrade(g: string, steps: number, discipline: 'route' | 'boulder'): string | null {
  const ladder = discipline === 'route' ? SPORT : FONT;
  const i = gradeIndex(g, discipline);
  if (i < 0) return null;
  return ladder[Math.max(0, Math.min(ladder.length - 1, i + steps))];
}
