/** App shell: theme, accent colour, bottom navigation, routes, reminders. */
import { useEffect, type ReactNode } from 'react';
import { startReminderLoop } from '../app/reminders';
import { reviewWeekFor } from '../app/proposals';
import { useRoute, navigate } from './router';
import { useStore } from './store';
import { hexToRgbTriplet } from './format';
import { Toasts } from './components/ui';
import { IconBody, IconLog, IconPlan, IconSession, IconSettings, IconStats, IconToday } from './components/icons';
import { TodayPage } from './pages/Today';
import { PlanPage } from './pages/Plan';
import { SessionPage } from './pages/Session';
import { LogPage } from './pages/Log';
import { StatsPage } from './pages/Stats';
import { BodyPage } from './pages/Body';
import { SettingsPage } from './pages/Settings';
import { OnboardingPage } from './pages/Onboarding';

const NAV: { path: string; label: string; icon: () => JSX.Element }[] = [
  { path: 'today', label: 'Today', icon: IconToday },
  { path: 'plan', label: 'Plan', icon: IconPlan },
  { path: 'session', label: 'Session', icon: IconSession },
  { path: 'log', label: 'Log', icon: IconLog },
  { path: 'stats', label: 'Stats', icon: IconStats },
  { path: 'body', label: 'Body', icon: IconBody },
  { path: 'settings', label: 'Settings', icon: IconSettings },
];

export function App() {
  const { d, data, toasts } = useStore();
  const route = useRoute();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', d.settings.theme === 'dark');
    root.style.setProperty('--accent', hexToRgbTriplet(d.settings.accent));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', d.settings.theme === 'dark' ? '#0b0d10' : '#f6f7f9');
  }, [d.settings.theme, d.settings.accent]);

  useEffect(() => {
    if (!d.settings.onboardingDone && route.path === 'today' && !d.plan) navigate('onboarding');
  }, [d.settings.onboardingDone, d.plan, route.path]);

  useEffect(
    () =>
      startReminderLoop(() => ({
        settings: d.settings.reminders,
        ctx: {
          today: d.today,
          hasSessionToday: d.todaySessions.find((s) => s.status === 'planned' && s.kind !== 'prehab')?.title ?? null,
          checkedIn: d.checkedInToday,
          isSunday: d.isReviewDay,
          reviewDone: data.weeklyReviews.some((w) => w.weekStart === reviewWeekFor(d.today) && w.completedAt),
        },
      })),
    [d, data.weeklyReviews],
  );

  let page: ReactNode;
  switch (route.path) {
    case 'plan':
      page = <PlanPage />;
      break;
    case 'session':
      page = <SessionPage parts={route.parts} />;
      break;
    case 'log':
      page = <LogPage parts={route.parts} key={route.parts.join('/')} />;
      break;
    case 'stats':
      page = <StatsPage />;
      break;
    case 'body':
      page = <BodyPage parts={route.parts} key={route.parts.join('/')} />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    case 'onboarding':
      page = <OnboardingPage />;
      break;
    default:
      page = <TodayPage />;
  }

  return (
    <div className="min-h-full">
      <Toasts items={toasts} />
      <main className="max-w-xl mx-auto px-4 pt-5 pb-28 sm:pl-24 sm:max-w-3xl">{page}</main>
      <nav className="fixed bottom-0 inset-x-0 z-20 bg-card/95 backdrop-blur border-t border-line safe-bottom sm:inset-y-0 sm:left-0 sm:right-auto sm:w-20 sm:border-t-0 sm:border-r">
        <ul className="flex justify-around sm:flex-col sm:justify-start sm:gap-2 sm:pt-6">
          {NAV.map((n) => {
            const active = route.path === n.path || (n.path === 'today' && route.path === 'onboarding');
            const Icon = n.icon;
            return (
              <li key={n.path} className="flex-1 sm:flex-none">
                <a
                  href={`#/${n.path}`}
                  className={`relative flex flex-col items-center justify-center min-h-[60px] text-[11px] gap-0.5 transition ${active ? 'text-accent' : 'text-muted'}`}
                >
                  <Icon />
                  {n.label}
                  {n.path === 'today' && d.pending.length > 0 && <span className="absolute top-2 right-[calc(50%-16px)] w-2 h-2 rounded-full bg-accent" />}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
