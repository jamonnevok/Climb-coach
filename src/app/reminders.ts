/**
 * Optional reminders: morning check-in, session, Sunday weekly review.
 * Free and server-less: checks run every minute while the app is open or kept in the
 * background (installed PWA), using the Notification API via the service worker.
 * Limitation: without a push server, a fully closed app cannot be woken up — see README.
 */
import type { ReminderSettings } from '../data/schema';

const KEY = 'climbcoach.reminders.fired';

type Kind = keyof ReminderSettings;

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

function fired(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function markFired(kind: Kind, date: string) {
  localStorage.setItem(KEY, JSON.stringify({ ...fired(), [kind]: date }));
}

async function show(title: string, body: string, tag: string) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (reg) await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
  else new Notification(title, { body, tag });
}

export interface ReminderContext {
  today: string;
  hasSessionToday: string | null; // title or null
  checkedIn: boolean;
  isSunday: boolean;
  reviewDone: boolean;
}

/** Pure decision: which reminders are due now (for tests and the scheduler). */
export function dueReminders(r: ReminderSettings, ctx: ReminderContext, nowHHMM: string, firedMap: Record<string, string>): Kind[] {
  const due: Kind[] = [];
  const ready = (k: Kind) => r[k] !== null && (r[k] as string) <= nowHHMM && firedMap[k] !== ctx.today;
  if (ready('morningCheckin') && !ctx.checkedIn) due.push('morningCheckin');
  if (ready('sessionReminder') && ctx.hasSessionToday) due.push('sessionReminder');
  if (ready('weeklyReview') && ctx.isSunday && !ctx.reviewDone) due.push('weeklyReview');
  return due;
}

export function startReminderLoop(get: () => { settings: ReminderSettings; ctx: ReminderContext }): () => void {
  const check = () => {
    const { settings, ctx } = get();
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    for (const k of dueReminders(settings, ctx, hhmm, fired())) {
      markFired(k, ctx.today);
      if (k === 'morningCheckin') void show('Morning check-in', '30 seconds: sleep, fatigue, fingers.', 'checkin');
      if (k === 'sessionReminder') void show('Session today', ctx.hasSessionToday ?? '', 'session');
      if (k === 'weeklyReview') void show('Weekly review', '2 minutes to review the week and adjust the next one.', 'review');
    }
  };
  check();
  const id = window.setInterval(check, 60_000);
  return () => clearInterval(id);
}
