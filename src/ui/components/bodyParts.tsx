/**
 * Body map: two hands (thumb..little) with A2 / A3 / A4 pulley zones per finger,
 * plus wrist, elbow, shoulder and skin. Tapping a zone returns a BodyLocation.
 * Zones are coloured by the current pain traffic light.
 */
import type { BodyLocation, FingerName, Pulley, Side } from '../../data/schema';
import type { PainEvaluation } from '../../engine/pain';
import { locationKey } from '../../engine/pain';

const FINGERS: FingerName[] = ['index', 'middle', 'ring', 'little'];
const PULLEYS: Pulley[] = ['A4', 'A3', 'A2'];
const LIGHT_FILL: Record<string, string> = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444', red_flag: '#ef4444' };

function Hand({ side, evals, onPick, selected }: { side: Side; evals: Map<string, PainEvaluation>; onPick: (l: BodyLocation) => void; selected?: string | null }) {
  // Palm view, fingers up. Left hand: little finger on the left of the drawing.
  const order = side === 'left' ? [...FINGERS].reverse() : FINGERS;
  const lengths: Record<FingerName, number> = { thumb: 0, index: 92, middle: 102, ring: 96, little: 78 };
  const fw = 26;
  const gap = 6;
  const baseY = 130;
  const x0 = 12;
  return (
    <svg viewBox="0 0 150 230" className="w-full max-w-[180px]">
      <rect x={x0 - 4} y={baseY} width={4 * fw + 3 * gap + 8} height={78} rx={22} className="fill-line" />
      {order.map((f, i) => {
        const x = x0 + i * (fw + gap);
        const len = lengths[f];
        const top = baseY - len + 6;
        const segH = (len - 6) / 3;
        return (
          <g key={f}>
            <rect x={x} y={top} width={fw} height={len} rx={12} className="fill-line" />
            {PULLEYS.map((p, j) => {
              const loc: BodyLocation = { region: 'finger', side, finger: f, structure: p };
              const k = locationKey(loc);
              const e = evals.get(k);
              const y = top + j * segH + 2;
              return (
                <g key={p} onClick={() => onPick(loc)} className="cursor-pointer">
                  <rect x={x + 2} y={y} width={fw - 4} height={segH - 4} rx={6} fill={e ? LIGHT_FILL[e.light] : 'transparent'} fillOpacity={e ? 0.75 : 0} stroke={selected === k ? 'rgb(var(--accent))' : 'rgb(var(--muted))'} strokeOpacity={selected === k ? 1 : 0.35} strokeWidth={selected === k ? 2 : 1} />
                  <text x={x + fw / 2} y={y + segH / 2} textAnchor="middle" fontSize={8} className="fill-fg pointer-events-none">
                    {p}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
      {(() => {
        const loc: BodyLocation = { region: 'finger', side, finger: 'thumb', structure: 'other' };
        const e = evals.get(locationKey(loc));
        const tx = side === 'left' ? x0 + 4 * fw + 3 * gap + 2 : x0 - 14;
        return (
          <rect x={tx} y={baseY + 8} width={18} height={52} rx={9} className="cursor-pointer fill-line" fill={e ? LIGHT_FILL[e.light] : undefined} onClick={() => onPick(loc)} />
        );
      })()}
      <text x={75} y={226} textAnchor="middle" fontSize={11} className="fill-muted">
        {side === 'left' ? 'Left (palm)' : 'Right (palm)'}
      </text>
    </svg>
  );
}

export function BodyMap({ evals, onPick, selected }: { evals: PainEvaluation[]; onPick: (l: BodyLocation) => void; selected?: string | null }) {
  const map = new Map(evals.map((e) => [e.key, e]));
  const other = (region: 'wrist' | 'elbow' | 'shoulder' | 'skin', side: Side) => {
    const loc: BodyLocation = region === 'skin' ? { region, side } : { region, side };
    const e = map.get(locationKey(loc));
    return (
      <button
        key={region + side}
        onClick={() => onPick(loc)}
        className={`h-11 rounded-xl text-sm border ${selected === locationKey(loc) ? 'border-accent' : 'border-line'}`}
        style={e ? { background: LIGHT_FILL[e.light] + '40' } : undefined}
      >
        {side === 'left' ? 'L' : 'R'} {region}
      </button>
    );
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-around">
        <Hand side="left" evals={map} onPick={onPick} selected={selected} />
        <Hand side="right" evals={map} onPick={onPick} selected={selected} />
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(['wrist', 'elbow', 'shoulder', 'skin'] as const).flatMap((r) => [other(r, 'left'), other(r, 'right')])}
      </div>
    </div>
  );
}
