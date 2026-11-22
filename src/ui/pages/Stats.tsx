/**
 * STATS: weekly load bars, ACWR (global & finger) with zones, benchmark progress,
 * wellness & sleep, finger pain, Tindeq force per hand, grade pyramid, force curves.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ForceCurve } from '../../data/schema';
import { addDays } from '../../lib/dates';
import { fontIndex, sportIndex } from '../../lib/grades';
import { weeklyBars } from '../../engine/load';
import { useStore } from '../store';
import { fmtDate } from '../format';
import { Card, Empty, Section, Segmented } from '../components/ui';
import { BarChart, ForceCurveChart, LineChart, Pyramid } from '../components/charts';
import { AcwrInfo, ZoneChip } from '../components/widgets';

const ACCENT = 'rgb(var(--accent))';
const ZONES = [
  { from: 0.8, to: 1.3, color: 'rgba(34,197,94,0.10)' },
  { from: 1.3, to: 1.5, color: 'rgba(245,158,11,0.12)' },
  { from: 1.5, to: 3, color: 'rgba(239,68,68,0.10)' },
];

export function StatsPage() {
  const { d, data, svc } = useStore();
  const [range, setRange] = useState<56 | 112 | 365>(112);
  const [discipline, setDiscipline] = useState<'route' | 'boulder'>('route');
  const [curves, setCurves] = useState<ForceCurve[]>([]);
  useEffect(() => {
    void svc.forceCurves().then((c) => setCurves(c.sort((a, b) => b.takenAt.localeCompare(a.takenAt)).slice(0, 10)));
  }, [svc]);

  const from = addDays(d.today, -range + 1);
  const weeks = weeklyBars(d.loads, d.today, Math.round(range / 7));
  const gSeries = d.global.series.filter((p) => p.date >= from);
  const fSeries = d.finger.series.filter((p) => p.date >= from);
  const acwrDates = (gSeries.length >= fSeries.length ? gSeries : fSeries).map((p) => p.date);
  const byDate = (s: typeof gSeries) => new Map(s.map((p) => [p.date, p.ratio]));
  const gm = byDate(gSeries);
  const fm = byDate(fSeries);

  const bench = (type: string, hand?: string) =>
    data.benchmarks.filter((b) => b.type === type && (!hand || b.hand === hand) && b.date >= from).sort((a, b) => a.date.localeCompare(b.date));
  const hang = bench('max_hang_20mm_10s_hc');
  const pf = { left: bench('tindeq_peak_force', 'left'), right: bench('tindeq_peak_force', 'right') };
  const pfDates = [...new Set([...pf.left, ...pf.right].map((b) => b.date))].sort();

  const rd = d.readiness.filter((r) => r.date >= addDays(d.today, -27));
  const painDays = useMemo(() => {
    const days = Array.from({ length: Math.min(range, 90) }, (_, i) => addDays(d.today, -Math.min(range, 90) + 1 + i));
    return days.map((day) => {
      const xs = data.pain.filter((p) => p.date === day && p.location.region === 'finger').map((p) => p.pain);
      return { day, v: xs.length ? Math.max(...xs) : null };
    });
  }, [data.pain, d.today, range]);

  const pyramid = useMemo(() => {
    const idx = discipline === 'route' ? sportIndex : fontIndex;
    const counts = new Map<string, { sends: number; attempts: number }>();
    for (const c of data.climbs.filter((x) => x.discipline === discipline && x.date >= from)) {
      const k = counts.get(c.grade) ?? { sends: 0, attempts: 0 };
      if (c.style === 'attempt') k.attempts++;
      else k.sends++;
      counts.set(c.grade, k);
    }
    return [...counts.entries()].map(([grade, v]) => ({ grade, ...v })).sort((a, b) => idx(b.grade) - idx(a.grade));
  }, [data.climbs, discipline, from]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Stats</h1>
      <Segmented value={range} onChange={setRange} options={[{ value: 56, label: '8 wk' }, { value: 112, label: '16 wk' }, { value: 365, label: '1 yr' }]} />

      <Section title="Weekly load">
        <Card className="space-y-4">
          <BarChart labels={weeks.map((w) => w.weekStart.slice(5))} series={[{ name: 'Global (AU)', color: ACCENT, values: weeks.map((w) => w.global) }]} />
          <BarChart
            labels={weeks.map((w) => w.weekStart.slice(5))}
            stacked
            series={[
              { name: 'Finger (FLU)', color: '#a78bfa', values: weeks.map((w) => Math.round((w.finger - w.restricted) * 10) / 10) },
              { name: 'Restricted grips', color: '#f59e0b', values: weeks.map((w) => w.restricted) },
            ]}
          />
        </Card>
      </Section>

      <Section title="ACWR">
        <Card className="space-y-2">
          <div className="flex gap-2 text-sm">
            Global <ZoneChip r={d.global} /> Finger <ZoneChip r={d.finger} />
          </div>
          {acwrDates.length ? (
            <LineChart
              labels={acwrDates.map((x) => x.slice(5))}
              series={[
                { name: 'Global', color: ACCENT, values: acwrDates.map((x) => gm.get(x) ?? null) },
                { name: 'Finger', color: '#a78bfa', values: acwrDates.map((x) => fm.get(x) ?? null) },
              ]}
              bands={ZONES}
              yMin={0}
              yMax={2}
            />
          ) : (
            <Empty>No load data yet.</Empty>
          )}
          {d.calibration.calibrating && <p className="text-xs text-muted">{d.calibration.label}</p>}
          <AcwrInfo />
        </Card>
      </Section>

      <Section title="Benchmarks">
        <Card className="space-y-4">
          {hang.length ? (
            <div>
              <div className="text-sm text-muted mb-1">Max hang 20 mm (% BW total)</div>
              <LineChart labels={hang.map((b) => b.date.slice(5))} series={[{ name: '% BW', color: ACCENT, values: hang.map((b) => Math.round(((b.bodyMassKg + b.value) / b.bodyMassKg) * 1000) / 10) }]} yMin={80} dots />
            </div>
          ) : (
            <Empty>No max hang results in this range.</Empty>
          )}
          {pfDates.length > 0 && (
            <div>
              <div className="text-sm text-muted mb-1">Tindeq peak force per hand (kg)</div>
              <LineChart
                labels={pfDates.map((x) => x.slice(5))}
                series={[
                  { name: 'Left', color: '#60a5fa', values: pfDates.map((x) => pf.left.find((b) => b.date === x)?.value ?? null) },
                  { name: 'Right', color: '#f472b6', values: pfDates.map((x) => pf.right.find((b) => b.date === x)?.value ?? null) },
                ]}
                dots
              />
              {d.asymmetry.asymmetryPct !== null && <p className="text-xs text-muted">Latest left/right difference {d.asymmetry.asymmetryPct} % (experimental watch at &gt; 10 %).</p>}
            </div>
          )}
        </Card>
      </Section>

      <Section title="Wellness & sleep (28 d)">
        <Card className="space-y-4">
          <LineChart labels={rd.map((r) => r.date.slice(5))} series={[{ name: 'Readiness', color: ACCENT, values: rd.map((r) => r.score) }]} yMin={0} yMax={100} />
          <BarChart labels={rd.map((r) => r.date.slice(8))} series={[{ name: 'Sleep (h)', color: '#60a5fa', values: rd.map((r) => r.sleepH) }]} height={110} />
          <p className="text-xs text-muted">Sleep baseline {d.sleepBaselineH} h.</p>
        </Card>
      </Section>

      <Section title="Finger pain">
        <Card>
          {painDays.some((p) => p.v !== null) ? (
            <LineChart labels={painDays.map((p) => p.day.slice(5))} series={[{ name: 'Max finger pain', color: '#ef4444', values: painDays.map((p) => p.v) }]} yMin={0} yMax={10} bands={[{ from: 0, to: 2, color: 'rgba(34,197,94,0.08)' }, { from: 2, to: 5, color: 'rgba(245,158,11,0.08)' }, { from: 5, to: 10, color: 'rgba(239,68,68,0.08)' }]} dots />
          ) : (
            <Empty>No finger pain recorded.</Empty>
          )}
        </Card>
      </Section>

      <Section title="Grade pyramid" action={<Segmented value={discipline} onChange={setDiscipline} options={[{ value: 'route', label: 'Routes' }, { value: 'boulder', label: 'Boulders' }]} />}>
        <Card>{pyramid.length ? <Pyramid rows={pyramid} /> : <Empty>No climbs logged in this range.</Empty>}</Card>
      </Section>

      <Section title="Recent force curves">
        {curves.length ? (
          curves.map((c) => (
            <Card key={c.id}>
              <div className="text-xs text-muted">
                {fmtDate(c.takenAt.slice(0, 10))} · {c.context} · {c.hand}
              </div>
              <ForceCurveChart t={c.t} f={c.f} />
            </Card>
          ))
        ) : (
          <Empty>No Tindeq curves yet.</Empty>
        )}
      </Section>
    </div>
  );
}
