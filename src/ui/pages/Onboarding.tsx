/** First-run onboarding: profile → typical week (cold start) → schedule → questionnaire → tests → plan. */
import { useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../router';
import { Button, Card, Field, Stepper } from '../components/ui';
import { ColdStartForm, ProfileForm, QuestionnaireForm } from './Settings';
import { BenchmarkSheet } from '../components/forms';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function OnboardingPage() {
  const { d, data, svc, run } = useStore();
  const [step, setStep] = useState(0);
  const [bench, setBench] = useState(false);
  const steps = ['Profile', 'Typical week', 'Schedule', 'Self-assessment', 'Tests', 'Plan'];
  const s = d.settings;
  const nextStep = () => setStep((x) => Math.min(steps.length - 1, x + 1));
  return (
    <div className="space-y-5">
      <div>
        <div className="text-sm text-muted">
          Step {step + 1}/{steps.length}
        </div>
        <h1 className="text-2xl font-bold">{steps[step]}</h1>
        <div className="flex gap-1 mt-2">
          {steps.map((x, i) => (
            <div key={x} className={`h-1 flex-1 rounded ${i <= step ? 'bg-accent' : 'bg-line'}`} />
          ))}
        </div>
      </div>

      {step === 0 && (
        <Card className="space-y-3">
          <p className="text-sm text-muted">Pre-filled from your brief. Every value stays editable with dated history; the plan always uses the latest.</p>
          <ProfileForm onSaved={nextStep} />
        </Card>
      )}
      {step === 1 && (
        <Card>
          <ColdStartForm onSaved={nextStep} />
        </Card>
      )}
      {step === 2 && (
        <Card className="space-y-4">
          <Field label="Sessions per week">
            <Stepper value={s.sessionsPerWeek} onChange={(v) => void run(() => svc.updateSettings({ sessionsPerWeek: v }))} min={1} max={4} />
          </Field>
          <Field label="Preferred training days">
            <div className="flex gap-1">
              {DAYS.map((x, i) => (
                <button
                  key={x}
                  onClick={() => void run(() => svc.updateSettings({ preferredDays: s.preferredDays.includes(i) ? s.preferredDays.filter((y) => y !== i) : [...s.preferredDays, i].sort() }))}
                  className={`flex-1 h-10 rounded-lg text-sm ${s.preferredDays.includes(i) ? 'bg-accent text-black font-semibold' : 'bg-line/50 text-muted'}`}
                >
                  {x}
                </button>
              ))}
            </div>
          </Field>
          <p className="text-xs text-muted">Weekday sessions ~{s.weekdaySessionMin} min; longer outdoor days are added per week in the Plan.</p>
          <Button className="w-full" onClick={nextStep}>
            Continue
          </Button>
        </Card>
      )}
      {step === 3 && (
        <Card className="space-y-3">
          <QuestionnaireForm onSaved={nextStep} />
          <Button tone="ghost" className="w-full" onClick={nextStep}>
            Skip for now
          </Button>
        </Card>
      )}
      {step === 4 && (
        <Card className="space-y-3">
          <p className="text-sm">Recent test results (last ~4 weeks)? Enter them now. Otherwise, week 1 of your plan becomes an assessment week.</p>
          <p className="text-sm text-muted">{data.benchmarks.length} result(s) entered.</p>
          <Button tone="ghost" className="w-full" onClick={() => setBench(true)}>
            Add a test result
          </Button>
          <Button className="w-full" onClick={nextStep}>
            Continue
          </Button>
          {bench && <BenchmarkSheet open onClose={() => setBench(false)} />}
        </Card>
      )}
      {step === 5 && (
        <Card className="space-y-3">
          <p className="text-sm">The plan is generated as a <b>draft</b>: review the weeks, move sessions, then validate.</p>
          <ol className="text-sm text-muted list-decimal pl-5 space-y-1">
            <li>Top weaknesses: {d.ranking.top.map((t) => d.ranking.ranked.find((r) => r.domain === t)?.label).join(', ')}</li>
            <li>{s.sessionsPerWeek} sessions/week + 2 short finger-prehab slots</li>
            <li>Blocks: strength → power → performance, deload + re-test at each block end</li>
          </ol>
          <Button
            className="w-full"
            onClick={() =>
              void run(async () => {
                await svc.updateSettings({ onboardingDone: true });
                await svc.generatePlan('Initial plan');
                navigate('plan');
              }, 'Plan generated — review & validate')
            }
          >
            Generate my plan
          </Button>
        </Card>
      )}
      {step > 0 && (
        <button className="text-sm text-muted" onClick={() => setStep(step - 1)}>
          ‹ Back
        </button>
      )}
    </div>
  );
}
