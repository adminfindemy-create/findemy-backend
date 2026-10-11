import { describe, it, expect } from 'vitest';
import {
  issuableSessionAt,
  sessionWindowsBetween,
  sessionWindowsOn,
} from '../lib/session-window.js';
import { istWallClockToUtc } from '../lib/ist.js';

// A Mon/Wed/Fri batch, 5:00–6:30 PM IST. 2026-07-27 is a Monday.
const MWF = [
  { dayOfWeek: 1, startTime: '17:00', durationMin: 90 },
  { dayOfWeek: 3, startTime: '17:00', durationMin: 90 },
  { dayOfWeek: 5, startTime: '17:00', durationMin: 90 },
];

/** "now", stated as an IST wall clock. */
const ist = istWallClockToUtc;

describe('session windows', () => {
  it('derives one window per timing on the day', () => {
    const [w] = sessionWindowsOn(MWF, '2026-07-27');
    expect(w.start.toISOString()).toBe('2026-07-27T11:30:00.000Z'); // 5:00 PM IST
    expect(w.end.toISOString()).toBe('2026-07-27T13:00:00.000Z'); // 6:30 PM IST
    expect(w.issueOpensAt.toISOString()).toBe('2026-07-27T11:20:00.000Z'); // start − 10
    expect(w.tokenExpiresAt.toISOString()).toBe('2026-07-27T13:10:00.000Z'); // end + 10
    expect(w.closesAt.toISOString()).toBe('2026-07-27T13:15:00.000Z'); // end + 15
  });

  it('has no window on a day the batch never meets', () => {
    expect(sessionWindowsOn(MWF, '2026-07-26')).toHaveLength(0); // Sunday
  });

  // The bug this replaces: a QR could be issued on Sunday 11am for a Mon/Wed/Fri batch.
  it('refuses to issue outside the class window', () => {
    expect(issuableSessionAt(MWF, ist('2026-07-26', 11, 0))).toBeNull(); // Sunday
    expect(issuableSessionAt(MWF, ist('2026-07-27', 9, 0))).toBeNull(); // right day, morning
    expect(issuableSessionAt(MWF, ist('2026-07-27', 16, 49))).toBeNull(); // 11 min early
    expect(issuableSessionAt(MWF, ist('2026-07-27', 18, 31))).toBeNull(); // 1 min after the end
  });

  it('issues from 10 minutes before the start until the class ends', () => {
    expect(issuableSessionAt(MWF, ist('2026-07-27', 16, 50))?.sessionDate).toBe('2026-07-27');
    expect(issuableSessionAt(MWF, ist('2026-07-27', 17, 45))?.sessionDate).toBe('2026-07-27');
    expect(issuableSessionAt(MWF, ist('2026-07-27', 18, 30))?.sessionDate).toBe('2026-07-27');
  });

  // A late class belongs to the day it started — that is the date its attendance rows are keyed by.
  it('keeps a past-midnight class on its own start date', () => {
    const lateNight = [{ dayOfWeek: 1, startTime: '23:30', durationMin: 90 }];
    const w = issuableSessionAt(lateNight, ist('2026-07-28', 0, 30));
    expect(w?.sessionDate).toBe('2026-07-27');
  });

  it('projects a date range from the timetable', () => {
    const windows = sessionWindowsBetween(MWF, '2026-07-27', '2026-08-02');
    expect(windows.map((w) => w.sessionDate)).toEqual(['2026-07-27', '2026-07-29', '2026-07-31']);
  });
});
