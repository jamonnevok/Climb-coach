/** Feature widgets shared by several pages. */
import { useState } from 'react';
import { thresholds } from '../../config';
import type { Proposal } from '../../data/schema';
import type { AcwrResult } from '../../engine/load';
import type { ReadinessResult } from '../../engine/readiness';
import { useStore } from '../store';
import { ZONE_STYLE, fmtNum } from '../format';
import { Badge, Button, Card } from './ui';

export function ZoneChip({ r }: { r: AcwrResult }) {
  const z = ZONE_STYLE[r.zone];
  return (
    <Badge cls={z.cls}>
      {r.zone === 'calibrating' ? `Calibrating · ${fmtNum(r.ratio, 2)}` : r.ratio === null ? z.label : `${fmtNum(r.ratio, 2)} · ${z.label}`}
    </Badge>
  );
}

export function AcwrInfo() {
  return <p className="text-xs text-muted">{thresholds.acwr.note}</p>;
}

export function ReadinessBadge({ r }: { r: ReadinessResult | undefined }) {
  if (!r || r.score === null) return <Badge>No check-in</Badge>;
  const cls = r.advice === 'proceed' ? 'bg-ok/15 text-ok' : r.advice === 'lighter' ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad';
  const label = r.advice === 'proceed' ? 'Proceed' : r.advice === 'lighter' ? 'Lighter' : 'Rest';
  return (
    <Badge cls={cls}>
      {r.score} · {label}
    </Badge>
  );
}

const KIND_TONE: Partial<Record<Proposal['kind'], string>> = {
  pain_stop: 'border-bad/60',
  pain_modify: 'border-warn/60',
  deload: 'border-warn/60',
  downgrade: 'border-warn/60',
};

/** One-tap accept / reject. Edit = adjust the key value before accepting (where meaningful). */
export function ProposalCard({ p }: { p: Proposal }) {
  const { svc, run } = useStore();
  const [editing, setEditing] = useState(false);
  const editableValue = p.kind === 'progression' ? (p.payload.value as number) : p.kind === 'reschedule' ? (p.payload.toDate as string) : null;
  const [edit, setEdit] = useState<string>(editableValue === null ? '' : String(editableValue));
  const seePhysio = p.payload.seePhysio === true;
  return (
    <Card className={`space-y-3 ${KIND_TONE[p.kind] ?? ''}`}>
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold">{p.title}</h3>
          {seePhysio && <Badge cls="bg-bad text-white">Red flag</Badge>}
        </div>
        <p className="text-sm text-muted mt-1">{p.reason}</p>
        {p.triggers.length > 1 && <p className="text-xs text-muted mt-1">Signals: {p.triggers.filter((t) => t !== 'pain').join(' · ')}</p>}
      </div>
      {editing && editableValue !== null && (
        <input type={p.kind === 'reschedule' ? 'date' : 'number'} step={0.5} value={edit} onChange={(e) => setEdit(e.target.value)} />
      )}
      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() =>
            void run(
              () => svc.acceptProposal(p.id, editing ? (p.kind === 'progression' ? { value: Number(edit) } : { toDate: edit }) : undefined),
              seePhysio ? 'Noted. Training adjusted — please book a physio.' : 'Applied',
            )
          }
        >
          {seePhysio ? 'Acknowledge & adjust' : editing ? 'Apply edit' : 'Accept'}
        </Button>
        {editableValue !== null && !editing && (
          <Button tone="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button tone="ghost" onClick={() => void run(() => svc.rejectProposal(p.id), 'Dismissed')}>
          Reject
        </Button>
      </div>
    </Card>
  );
}
