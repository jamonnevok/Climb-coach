import { describe, expect, it } from 'vitest';
import { dueReminders } from '../src/app/reminders';

const r = { morningCheckin: '07:30', sessionReminder: '17:00', weeklyReview: '19:00' };
const ctx = { today: '2026-11-29', hasSessionToday: 'Fingers', checkedIn: false, isSunday: true, reviewDone: false };

describe('reminders', () => {
  it('fires each reminder once per day after its time, only when relevant', () => {
    expect(dueReminders(r, ctx, '07:00', {})).toEqual([]);
    expect(dueReminders(r, ctx, '07:31', {})).toEqual(['morningCheckin']);
    expect(dueReminders(r, ctx, '19:05', {})).toEqual(['morningCheckin', 'sessionReminder', 'weeklyReview']);
    expect(dueReminders(r, { ...ctx, checkedIn: true, hasSessionToday: null, reviewDone: true }, '20:00', {})).toEqual([]);
    expect(dueReminders(r, ctx, '20:00', { morningCheckin: '2026-11-29', sessionReminder: '2026-11-29', weeklyReview: '2026-11-29' })).toEqual([]);
    expect(dueReminders({ ...r, weeklyReview: null }, { ...ctx, isSunday: true }, '20:00', { morningCheckin: '2026-11-29', sessionReminder: '2026-11-29' })).toEqual([]);
  });
});
