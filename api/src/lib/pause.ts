import {
  PAUSE_DURATION_WEEKS,
  PAUSE_WEEKS_PER_PERIOD,
  type Plan,
  type PauseDuration,
} from '@findemy/types';
import { istDateKey, istWallClockToUtc } from './ist.js';

// Pause policy (owner decision 2026-09-05). The rates live in @findemy/types because the student
// app must render the same allowance; this module is the server-side resolution + the "how many
// classes did that pause actually cover?" count.
//
// Why whole weeks: `BatchTiming` repeats weekly by `dayOfWeek`, so extending a paid period by
// `7 × weeks` days re-delivers precisely the weekdays that were skipped. That identity is the
// whole reason the allowance is denominated in weeks and `one_month` was dropped rather than a
// 10-day option added.

/** Statuses that consume allowance. `pending` counts so a student cannot stack requests past the
 *  cap while one awaits approval; `rejected` never counts. A pause resumed early still consumes
 *  its full granted length — the unused remainder is forfeited (owner decision). */
export const ALLOWANCE_CONSUMING_STATUSES = ['pending', 'approved', 'active', 'ended'] as const;

export function pauseWeeksForDuration(duration: string): number | null {
  return PAUSE_DURATION_WEEKS[duration as PauseDuration] ?? null;
}

export function pauseAllowanceWeeks(packageType: string): number {
  return PAUSE_WEEKS_PER_PERIOD[packageType as Plan] ?? 1;
}

export function pauseDurationDays(duration: string): number | null {
  const weeks = pauseWeeksForDuration(duration);
  return weeks === null ? null : weeks * 7;
}

/**
 * How many class occurrences fall in `[from, to)` for a batch's weekly timings — the count of
 * classes a pause window actually swallowed, used as the `SessionCredit.sessionCount` make-good.
 *
 * Day-by-day rather than arithmetic on purpose: it stays correct for multi-timing days and shares
 * `nextTimingOccurrenceAfter`'s IST wall-clock handling, so a class at 18:00 IST is counted on the
 * IST day the student experienced it, not the UTC one.
 */
export function countClassOccurrences(
  timings: { dayOfWeek: number; startTime: string }[],
  from: Date,
  to: Date,
): number {
  if (!timings.length || to <= from) return 0;
  let count = 0;
  const DAY_MS = 86400000;
  // Walk one extra day at each end so a boundary instant is classified by the comparisons below
  // rather than by which UTC day it happened to land in.
  for (let t = from.getTime() - DAY_MS; t <= to.getTime() + DAY_MS; t += DAY_MS) {
    const dateStr = istDateKey(new Date(t));
    const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    for (const timing of timings) {
      if (timing.dayOfWeek !== dow) continue;
      const [hh, mm] = timing.startTime.split(':').map(Number);
      const instant = istWallClockToUtc(dateStr, hh, mm);
      if (instant >= from && instant < to) count++;
    }
  }
  return count;
}

/**
 * Record the make-good for a pause window: one `SessionCredit` carrying the number of classes the
 * pause actually swallowed, mirroring what `sessions/service.ts` writes when a class is cancelled.
 *
 * The paid period is extended separately (by whole weeks when the pause ends, or by elapsed days
 * on an early resume) — that extension is the *delivery* of the missed classes. This credit is the
 * *count*, so the entitled `sessionsPerMonth` is provably preserved and the student can be shown
 * what was covered. Returns the number credited; 0 writes no row.
 */
export async function creditPauseCoverage(
  db: any,
  args: { enrollmentId: string; batchId: string; from: Date; to: Date; reason?: string },
): Promise<number> {
  const batch = await db.batch.findUnique({
    where: { id: args.batchId },
    select: { timings: { select: { dayOfWeek: true, startTime: true } } },
  });
  if (!batch) return 0;
  const sessionCount = countClassOccurrences(batch.timings, args.from, args.to);
  if (sessionCount <= 0) return 0;
  await db.sessionCredit.create({
    data: {
      enrollmentId: args.enrollmentId,
      batchId: args.batchId,
      reason: args.reason ?? 'enrollment_paused',
      sessionCount,
    },
  });
  return sessionCount;
}
