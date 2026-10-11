// The one definition of "when is this class, and how long does its QR live" — shared by the
// token issuer (attendance/service.ts) and the closer (workers/session-close.ts) so the two can
// never drift apart. See ai-usage/attendance-tracking_plan.md decisions 4 & 5.
//
// The QR lives exactly as long as the class, deliberately: absence is final and uncorrectable, so
// a token must not be able to outlive the close that wrote the absences. Hence
// TOKEN_GRACE_MIN < CLOSE_AFTER_MIN — the token is dead five minutes before the closer runs.
import { istDateKey, istWallClockToUtc } from './ist.js';

/** The QR may be shown from 10 min before the class starts. */
export const ISSUE_LEAD_MIN = 10;
/** A token issued mid-class expires 10 min after the class ends — never a fixed duration. */
export const TOKEN_GRACE_MIN = 10;
/** The session closes 15 min after it ends, five minutes after the QR stops working. */
export const CLOSE_AFTER_MIN = 15;

const MIN = 60_000;

export type Timing = { dayOfWeek: number; startTime: string; durationMin: number };

export type SessionWindow = {
  /** 'yyyy-MM-dd' IST calendar date — the ClassSession / BatchAttendance key. */
  sessionDate: string;
  start: Date;
  end: Date;
  /** Earliest instant the check-in QR may be issued. */
  issueOpensAt: Date;
  /** Latest instant a token may be issued (a QR is useless once the class is over). */
  issueClosesAt: Date;
  /** `exp` for a token issued for this session. */
  tokenExpiresAt: Date;
  /** When the closer may write absences. */
  closesAt: Date;
};

/** Every session a batch's timetable puts on the given IST date (usually one; two if a batch
 *  meets twice in a day). */
export function sessionWindowsOn(timings: Timing[], dateStr: string): SessionWindow[] {
  const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
  return timings
    .filter((t) => t.dayOfWeek === dow)
    .map((t) => {
      const [hh, mm] = t.startTime.split(':').map(Number);
      const start = istWallClockToUtc(dateStr, hh, mm);
      const end = new Date(start.getTime() + t.durationMin * MIN);
      return {
        sessionDate: dateStr,
        start,
        end,
        issueOpensAt: new Date(start.getTime() - ISSUE_LEAD_MIN * MIN),
        issueClosesAt: end,
        tokenExpiresAt: new Date(end.getTime() + TOKEN_GRACE_MIN * MIN),
        closesAt: new Date(end.getTime() + CLOSE_AFTER_MIN * MIN),
      };
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The session whose issue window (`start − 10 min` … `end`) contains `now`, or null.
 * Checks yesterday's IST date too: a class ending after IST midnight belongs to the day it
 * started, and that is the date its attendance rows are keyed by.
 */
export function issuableSessionAt(timings: Timing[], now: Date = new Date()): SessionWindow | null {
  const today = istDateKey(now);
  const yesterday = istDateKey(new Date(now.getTime() - 24 * 60 * MIN));
  const candidates = [...sessionWindowsOn(timings, yesterday), ...sessionWindowsOn(timings, today)];
  return candidates.find((w) => now >= w.issueOpensAt && now <= w.issueClosesAt) ?? null;
}

/** Sessions from the batch's timetable between two IST dates, inclusive. Read-side projection
 *  used for "which days should this batch have met" (closer, seed). */
export function sessionWindowsBetween(timings: Timing[], fromDateStr: string, toDateStr: string): SessionWindow[] {
  const out: SessionWindow[] = [];
  const from = new Date(`${fromDateStr}T00:00:00.000Z`);
  const to = new Date(`${toDateStr}T00:00:00.000Z`);
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 24 * 60 * MIN)) {
    out.push(...sessionWindowsOn(timings, d.toISOString().slice(0, 10)));
  }
  return out;
}
