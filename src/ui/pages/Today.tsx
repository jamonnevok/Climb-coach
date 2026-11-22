/** TODAY: session, readiness, sleep, global & finger ACWR, pending proposals, quick log. */
import { useState } from 'react';
import { projectSession } from '../../app/derive';
import { reviewWeekFor } from '../../app/proposals';
import type { PlannedSession } from '../../data/schema';
import { addDays } from '../../lib/dates';
import { navigate } from '../router';
import { useStore } from '../store';
import { BLOCK_LABELS, PAIN_STYLE, SESSION_KIND_LABELS, fmtDate, fmtNum, itemSummary } from '../format';
import { Badge, Button, Card, Empty, Section, Stat } from '../components/ui';
import { AcwrInfo, ProposalCard, ReadinessBadge, ZoneChip } from '../components/widgets';
import { CheckinSheet, QuickLogSheet } from '../components/forms';
import { WeeklyReviewSheet } from './WeeklyReview';

function SessionCard({ s }: { s: PlannedSession }) {
  const { d } = useStore();
  const proj = projectSession(d, s);
  const main = s.items.filter((i) => i.role !== 'warmup' && i.role !== 'cooldown');
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs text-muted">
            {SESSION_KIND_LABELS[s.kind]} · {s.estDurationMin} min · {s.location}
            {s.optional ? ' · optional' : ''}
          </div>
          <h3 className="text-lg font-semibold">{s.title}</h3>
        </div>
        {s.status === 'done' ? <Badge cls="bg-ok/15 text-ok">Done</Badge> : <Badge>Finger: {s.fingerIntensity}</Badge>}
      </div>
      <ul className="space-y-1 text-sm">
        {main.map((i) => {
          const ex = d.lib.get(i.exerciseId);
          return (
            <li key={i.id} className="flex justify-between gap-3">
              <span>{ex?.name ?? i.exerciseId}</span>
              <span className="text-muted text-right">{itemSummary(i, ex, d.profile.bodyMassKg)}</span>
            </li>
          );
        })}
      </ul>
      {s.status === 'planned' && !proj.global.calibrating && proj.peakFinger && (
        <p className={`text-xs ${proj.warning ? 'text-warn' : 'text-muted'}`}>
          Projected after this session: finger ACWR {fmtNum(proj.peakFinger.ratio, 2)}, global {fmtNum(proj.peakGlobal?.ratio ?? null, 2)}
          {proj.warning ? ' — above green, consider the lighter version.' : ''}
        </p>
      )}
      {s.status === 'planned' && (
        <Button className="w-full" onClick={() => navigate(`session/${s.id}`)}>
          Start guided session
        </Button>
      )}
    </Card>
  );
}

export function TodayPage() {
  const { d, data } = useStore();
  const [checkin, setCheckin] = useState(false);
  const [quick, setQuick] = useState(false);
  const [review, setReview] = useState(false);
  const rd = d.readinessToday;
  const sleep = data.sleep.filter((s) => s.date === d.today).sort((a) => (a.source === 'garmin' ? -1 : 1))[0];
  const block = d.plan?.macro[d.plan.currentBlockIndex];
  const week = d.plan?.weeks.find((w) => w.startDate <= d.today && d.today <= addDays(w.startDate, 6));
  const painAlerts = d.painEvals.filter((e) => e.light !== 'green');
  const todayMain = d.todaySessions.filter((s) => s.kind !== 'prehab');
  const todayPrehab = d.todaySessions.filter((s) => s.kind === 'prehab');
  const reviewWeek = reviewWeekFor(d.today);
  const reviewDone = data.weeklyReviews.some((w) => w.weekStart === reviewWeek && w.completedAt);
  const showReview = d.plan && !reviewDone && (d.isReviewDay || new Date(d.today + 'T12:00:00').getDay() === 1);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <div className="text-sm text-muted">{fmtDate(d.today, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1 className="text-2xl font-bold">Today</h1>
        </div>
        {block && (
          <div className="text-right text-xs text-muted">
            {BLOCK_LABELS[block.kind]} block
            {week ? ` · week ${week.index + 1}/${block.weeks}${week.isDeload ? ' (deload)' : ''}` : ''}
            {d.settings.mode !== 'normal' && <div className="text-accent">{d.settings.mode.replace('_', ' ')} mode</div>}
          </div>
        )}
      </header>

      {painAlerts.some((e) => e.light === 'red_flag') && (
        <Card className="border-bad bg-bad/10">
          <h3 className="font-semibold text-bad">Stop and see a physio</h3>
          <p className="text-sm mt-1">A red flag was recorded ({painAlerts.filter((e) => e.light === 'red_flag').flatMap((e) => e.reasons).join(' ')}). Avoid loading this area until a professional has assessed it.</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Card onClick={() => setCheckin(true)} className="space-y-2">
          <div className="text-xs text-muted">Readiness</div>
          <ReadinessBadge r={rd} />
          <div className="text-xs text-muted">{d.checkedInToday ? 'Tap to edit check-in' : 'Tap for 30 s check-in'}</div>
          {rd?.fingerLow && <div className="text-xs text-warn">Fingers low: downgrade finger work</div>}
        </Card>
        <Card className="space-y-1">
          <div className="text-xs text-muted">Sleep</div>
          <div className="text-xl font-semibold tabular">{sleep ? `${fmtNum(sleep.durationH, 2)} h` : '—'}</div>
          <div className="text-xs text-muted">
            baseline {fmtNum(d.sleepBaselineH, 2)} h{sleep?.sleepScore ? ` · score ${sleep.sleepScore}` : ''}
          </div>
        </Card>
        <Card className="space-y-2" onClick={() => navigate('stats')}>
          <div className="text-xs text-muted">Global ACWR</div>
          <ZoneChip r={d.global} />
          <div className="text-xs text-muted">7 d {Math.round(d.global.acute * 7)} AU</div>
        </Card>
        <Card className="space-y-2" onClick={() => navigate('stats')}>
          <div className="text-xs text-muted">Finger ACWR</div>
          <ZoneChip r={d.finger} />
          <div className="text-xs text-muted">
            week {fmtNum(d.wow.current.finger, 0)} / cap {fmtNum(d.caps.weeklyFingerCap, 0)} FLU
          </div>
        </Card>
      </div>
      {d.calibration.calibrating && (
        <p className="text-xs text-muted px-1">
          {d.calibration.label} ({d.calibration.daysRemaining} days left)
        </p>
      )}
      {(d.wow.fingerFlag || d.wow.globalFlag) && (
        <Card className="border-warn/60 text-sm">
          Week-on-week increase: {d.wow.fingerFlag ? `finger +${d.wow.fingerPct} %` : ''} {d.wow.globalFlag ? `global +${d.wow.globalPct} %` : ''} (flag above 15 %).
        </Card>
      )}

      {d.pending.length > 0 && (
        <Section title={`Proposals (${d.pending.length})`}>
          <div className="space-y-3">
            {d.pending.map((p) => (
              <ProposalCard key={p.id} p={p} />
            ))}
          </div>
        </Section>
      )}

      {showReview && (
        <Card className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold">Weekly review</div>
            <div className="text-sm text-muted">2 minutes: load, sleep, pain, adherence → next week</div>
          </div>
          <Button onClick={() => setReview(true)}>Open</Button>
        </Card>
      )}

      <Section title="Today's session">
        {!d.plan ? (
          <Card className="space-y-3">
            <p className="text-sm text-muted">No plan yet.</p>
            <Button className="w-full" onClick={() => navigate(d.settings.onboardingDone ? 'plan' : 'onboarding')}>
              {d.settings.onboardingDone ? 'Generate my plan' : 'Start onboarding'}
            </Button>
          </Card>
        ) : todayMain.length ? (
          <div className="space-y-3">
            {todayMain.map((s) => (
              <SessionCard key={s.id} s={s} />
            ))}
          </div>
        ) : (
          <Card>
            <Empty>
              Rest day.
              {d.nextSession && (
                <div className="mt-1">
                  Next: {d.nextSession.title} — {fmtDate(d.nextSession.date)}
                </div>
              )}
            </Empty>
          </Card>
        )}
        {todayPrehab.map((s) => (
          <Card key={s.id} className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">{s.title}</div>
              <div className="text-xs text-muted">{s.estDurationMin} min · finger-only</div>
            </div>
            {s.status === 'done' ? <Badge cls="bg-ok/15 text-ok">Done</Badge> : <Button small onClick={() => navigate(`session/${s.id}`)}>Start</Button>}
          </Card>
        ))}
      </Section>

      {painAlerts.length > 0 && (
        <Section title="Pain monitoring" action={<button className="text-sm text-accent" onClick={() => navigate('body')}>Body</button>}>
          <div className="space-y-2">
            {painAlerts.map((e) => (
              <Card key={e.key} className="flex items-center justify-between gap-3">
                <div className="text-sm">{e.reasons.join(' ')}</div>
                <Badge cls={PAIN_STYLE[e.light].cls}>{PAIN_STYLE[e.light].label}</Badge>
              </Card>
            ))}
          </div>
        </Section>
      )}

      {d.asymmetry.messages.length > 0 && (
        <Card className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">Tindeq watch</span>
            <Badge cls="bg-warn/15 text-warn">Experimental</Badge>
          </div>
          {d.asymmetry.messages.map((m) => (
            <p key={m} className="text-sm text-muted">
              {m}
            </p>
          ))}
        </Card>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Stat label="This week" value={`${d.wow.current.global}`} sub="AU" />
        <Stat label="Finger" value={fmtNum(d.wow.current.finger, 0)} sub="FLU" />
        <Stat label="Sessions" value={d.wow.current.sessions} sub="logged" />
      </div>
      <AcwrInfo />

      <button
        aria-label="Quick log"
        onClick={() => setQuick(true)}
        className="fixed right-5 bottom-24 z-40 w-14 h-14 rounded-full bg-accent text-black text-3xl shadow-lg active:scale-95 transition"
      >
        +
      </button>
      <CheckinSheet open={checkin} onClose={() => setCheckin(false)} />
      <QuickLogSheet open={quick} onClose={() => setQuick(false)} />
      {review && <WeeklyReviewSheet weekStart={reviewWeek} onClose={() => setReview(false)} />}
    </div>
  );
}
