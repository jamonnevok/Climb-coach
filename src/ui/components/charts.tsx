/** Dependency-free SVG charts (responsive via viewBox). */
const W = 340;

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted mt-1">
      {items.map((i) => (
        <span key={i.name} className="flex items-center gap-1">
          <span className="w-3 h-1.5 rounded" style={{ background: i.color }} />
          {i.name}
        </span>
      ))}
    </div>
  );
}

export function BarChart({ labels, series, height = 140, stacked = false }: { labels: string[]; series: Series[]; height?: number; stacked?: boolean }) {
  const n = labels.length;
  const totals = labels.map((_, i) => (stacked ? series.reduce((a, s) => a + (s.values[i] ?? 0), 0) : Math.max(...series.map((s) => s.values[i] ?? 0))));
  const max = niceMax(Math.max(1, ...totals));
  const padL = 30;
  const plotW = W - padL - 4;
  const bw = plotW / Math.max(1, n);
  const H = height;
  const plotH = H - 18;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W} y1={plotH - f * plotH + 2} y2={plotH - f * plotH + 2} stroke="currentColor" className="text-line" strokeWidth={0.5} />
            <text x={padL - 4} y={plotH - f * plotH + 5} textAnchor="end" fontSize={8} className="fill-muted">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => {
          let y0 = plotH + 2;
          const group = series.map((s, si) => {
            const v = s.values[i] ?? 0;
            const h = (v / max) * plotH;
            const x = stacked ? padL + i * bw + bw * 0.15 : padL + i * bw + bw * 0.1 + (si * bw * 0.8) / series.length;
            const w = stacked ? bw * 0.7 : (bw * 0.8) / series.length - 1;
            const y = stacked ? y0 - h : plotH + 2 - h;
            if (stacked) y0 -= h;
            return <rect key={s.name} x={x} y={y} width={Math.max(1, w)} height={Math.max(0, h)} rx={2} fill={s.color} />;
          });
          return (
            <g key={l + i}>
              {group}
              {(n <= 12 || i % Math.ceil(n / 12) === 0) && (
                <text x={padL + i * bw + bw / 2} y={H - 2} textAnchor="middle" fontSize={8} className="fill-muted">
                  {l}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && <Legend items={series} />}
    </div>
  );
}

export interface Band {
  from: number;
  to: number;
  color: string;
}

export function LineChart({
  labels,
  series,
  height = 150,
  bands = [],
  yMin,
  yMax,
  marker,
  dots = false,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  bands?: Band[];
  yMin?: number;
  yMax?: number;
  marker?: number;
  dots?: boolean;
}) {
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const lo = yMin ?? Math.min(0, ...vals);
  const hi = yMax ?? niceMax(Math.max(1, ...vals));
  const padL = 30;
  const H = height;
  const plotH = H - 18;
  const n = Math.max(2, labels.length);
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - 4);
  const y = (v: number) => 2 + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const path = (vs: (number | null)[]) => {
    let d = '';
    let pen = false;
    vs.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(Math.min(hi, Math.max(lo, v))).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const step = Math.ceil(labels.length / 6);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
        {bands.map((b) => (
          <rect key={b.color + b.from} x={padL} width={W - padL - 4} y={y(Math.min(hi, b.to))} height={Math.max(0, y(Math.max(lo, b.from)) - y(Math.min(hi, b.to)))} fill={b.color} />
        ))}
        {[0, 0.5, 1].map((f) => {
          const v = lo + (hi - lo) * f;
          return (
            <g key={f}>
              <line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-line" strokeWidth={0.5} />
              <text x={padL - 4} y={y(v) + 3} textAnchor="end" fontSize={8} className="fill-muted">
                {Math.round(v * 100) / 100}
              </text>
            </g>
          );
        })}
        {marker !== undefined && marker >= 0 && <line x1={x(marker)} x2={x(marker)} y1={2} y2={plotH + 2} stroke="currentColor" className="text-muted" strokeDasharray="3 3" strokeWidth={0.8} />}
        {series.map((s) => (
          <g key={s.name}>
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={1.8} strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinejoin="round" />
            {dots && s.values.map((v, i) => (v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={2.2} fill={s.color} />))}
          </g>
        ))}
        {labels.map((l, i) =>
          i % step === 0 ? (
            <text key={l + i} x={x(i)} y={H - 2} textAnchor="middle" fontSize={8} className="fill-muted">
              {l}
            </text>
          ) : null,
        )}
      </svg>
      {series.length > 1 && <Legend items={series} />}
    </div>
  );
}

/** Force curve (t in ms, f in kg). */
export function ForceCurveChart({ t, f, target, height = 120 }: { t: number[]; f: number[]; target?: number | null; height?: number }) {
  if (!t.length) return null;
  const tMax = t[t.length - 1] || 1;
  const fMax = niceMax(Math.max(1, ...f, target ?? 0));
  const H = height;
  const x = (v: number) => 4 + (v / tMax) * (W - 8);
  const y = (v: number) => H - 4 - (v / fMax) * (H - 8);
  const d = t.map((tv, i) => `${i ? 'L' : 'M'}${x(tv).toFixed(1)},${y(f[i]).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {target ? <rect x={4} width={W - 8} y={y(target * 1.05)} height={y(target * 0.95) - y(target * 1.05)} className="fill-accent/20" /> : null}
      <path d={d} fill="none" strokeWidth={1.6} className="stroke-accent" />
      <text x={W - 6} y={12} textAnchor="end" fontSize={9} className="fill-muted">
        peak {Math.max(...f).toFixed(1)} kg · {(tMax / 1000).toFixed(1)} s
      </text>
    </svg>
  );
}

/** Horizontal grade pyramid: rows = grades (hardest on top), bars = counts. */
export function Pyramid({ rows }: { rows: { grade: string; sends: number; attempts: number }[] }) {
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.sends + r.attempts));
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.grade} className="flex items-center gap-2 text-sm">
          <span className="w-10 text-right tabular text-muted">{r.grade}</span>
          <div className="flex-1 flex justify-center">
            <div className="flex h-5">
              <div className="bg-accent rounded-l" style={{ width: `${(r.sends / max) * 180}px` }} />
              <div className="bg-line rounded-r" style={{ width: `${(r.attempts / max) * 180}px` }} />
            </div>
          </div>
          <span className="w-12 tabular text-xs text-muted">
            {r.sends}
            {r.attempts ? ` +${r.attempts}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
