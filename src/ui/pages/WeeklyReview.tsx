/** Sunday weekly review (~2 min): summary + next-week adjustments (accept / edit / reject). */
import { useEffect, useState } from 'react';
import type { WeeklyReviewOutput } from '../../engine/weeklyReview';
import { useStore } from '../store';
import { fmtDate, fmtNum } from '../format';
import { Button, Sheet, Stat } from '../components/ui';

export function WeeklyReviewSheet({ weekStart, onClose }: { weekStart: string; onClose: () => void }) {
  const { svc, run } = useStore();
  const [out, setOut] = useState<WeeklyReviewOutput | null>(null);
  useEffect(() => {
    void svc.weeklyReviewPreview(weekStart).then(setOut);
  }, [svc, weekStart]);
  const s = out?.summary;
  return (
    <Sheet open onClose={onClose} title={`Week of ${fmtDate(weekStart, { day: 'numeric', month: 'short' })}`}>
      {!s ? (
        <p className="text-muted">Computing…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Load" value={s.globalLoad} sub="AU" />
            <Stat label="Finger" value={fmtNum(s.fingerLoad, 0)} sub="FLU" />
            <Stat label="Adherence" value={`${s.adherencePct} %`} />
            <Stat label="ACWR global" value={fmtNum(s.globalACWR, 2)} />
            <Stat label="ACWR finger" value={fmtNum(s.fingerACWR, 2)} />
            <Stat label="Max pain" value={`${s.maxPain}/10`} />
            <Stat label="Sleep avg" value={s.avgSleepH ? `${s.avgSleepH} h` : '—'} />
            <Stat label="Readiness avg" value={fmtNum(s.avgReadiness, 0)} />
          </div>
          {s.benchmarkNotes.length > 0 && (
            <div>
              <div className="text-sm text-muted mb-1">Benchmarks this week</div>
              <ul className="text-sm list-disc pl-5">
                {s.benchmarkNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="text-sm text-muted mb-2">Proposed for next week</div>
            {out.proposals.length === 0 ? (
              <p className="text-sm">No change needed — keep the plan as is.</p>
            ) : (
              <ul className="space-y-2">
                {out.proposals.map((p) => (
                  <li key={p.id} className="border border-line rounded-xl p-3">
                    <div className="font-medium">{p.title}</div>
                    <div className="text-sm text-muted">{p.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button
            className="w-full"
            onClick={() =>
              void run(async () => {
                await svc.completeWeeklyReview(weekStart);
                onClose();
              }, out.proposals.length ? 'Review saved — accept or reject the proposals on Today' : 'Review saved')
            }
          >
            Done
          </Button>
        </div>
      )}
    </Sheet>
  );
}
