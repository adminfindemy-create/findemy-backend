// The attendance engine: one place that turns ClassSession + BatchAttendance + enrolment history
// into the numbers every surface shows. The old engine multiplied `sessionsPerMonth` by months
// since enrolment, which ignored the real timetable, cancellations and pauses — so every
// percentage the app has ever shown was a formula, not a fact. See
// ai-usage/attendance-tracking_plan.md decisions 1, 6, 7 and 8.
//
// Two rules do all the work here:
//   * the denominator is FINALISED HELD sessions only. Cancelled sessions and "not recorded"
//     sessions (nobody checked in — the teacher never showed the QR) are excluded, because
//     counting them would blame students for the academy's misses.
//   * a student counts towards a session only if they were expected at it (isExpectedOn).
import { prisma } from '../../lib/prisma.js';
import type { BatchScope } from '../../lib/scope.js';
import {
  expectedLearnerIdsOn,
  isExpectedOn,
  type ExpectationEnrollment,
} from '../../lib/attendance-expectation.js';
import { attendancePct, tierOf, type AttendanceTier } from '../../lib/attendance-tier.js';

export type DateRange = { from: Date; to: Date };

/** Calendar month is the spine of every attendance screen — see plan decision 8. */
export function monthRange(month: string): DateRange {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error('Invalid month');
  return {
    from: new Date(Date.UTC(y, m - 1, 1)),
    to: new Date(Date.UTC(y, m, 0)), // last day of the month
  };
}

/** 'yyyy-MM' of a date, IST-safe because session dates are stored at UTC midnight. */
export function monthKeyOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

export type SessionSummary = {
  batch_id: string;
  session_date: string;
  /** held → the class ran; cancelled → the academy called it off. */
  status: 'held' | 'cancelled';
  /** false for a held session nobody checked into: "Not recorded", out of every denominator. */
  recorded: boolean;
  present: number;
  expected: number;
};

/** Why a student's row reads the way it does — shown as a chip next to their ratio. */
export type ReasonTag = 'paused' | 'left' | 'joined_this_month' | 'new' | null;

export type StudentStat = {
  /** Who attended. One row per learner per batch, so siblings in a batch are separate rows. */
  learner_id: string;
  /** The enrolling account (the guardian, for a child). */
  user_id: string;
  name: string | null;
  batch_id: string;
  expected: number;
  present: number;
  /** null when there is too little signal to score (fewer than 3 expected sessions). */
  pct: number | null;
  tier: AttendanceTier | null;
  reason_tag: ReasonTag;
  /** 'yyyy-MM-dd' — set when the student left, for the "Left 18 Jul" chip. */
  left_on: string | null;
};

export type BatchStats = {
  batch_id: string;
  students: number;
  held: number;
  cancelled: number;
  not_recorded: number;
  /** Batch attendance rate = total present / total expected. null when nothing counted. */
  avg_pct: number | null;
  sessions: SessionSummary[];
  per_student: StudentStat[];
};

type BatchInput = { id: string };

/**
 * Stats for a set of batches over an optional date range. One query per table, then in-memory
 * expectation — the alternative (a per-student SQL denominator) can't express "was this student
 * paused on that day" without joining pauses per session anyway.
 */
export async function statsForBatches(batchIds: string[], range?: DateRange): Promise<Map<string, BatchStats>> {
  const out = new Map<string, BatchStats>();
  if (batchIds.length === 0) return out;

  const dateWhere = range ? { gte: range.from, lte: range.to } : undefined;
  const [sessions, rows, enrollments] = await Promise.all([
    prisma.classSession.findMany({
      where: { batchId: { in: batchIds }, ...(dateWhere ? { sessionDate: dateWhere } : {}) },
      orderBy: { sessionDate: 'desc' },
    }),
    prisma.batchAttendance.findMany({
      where: { batchId: { in: batchIds }, ...(dateWhere ? { date: dateWhere } : {}) },
      select: { batchId: true, learnerId: true, date: true, present: true },
    }),
    prisma.enrollment.findMany({
      where: { batchId: { in: batchIds } },
      select: {
        batchId: true,
        userId: true,
        learnerId: true,
        startedAt: true,
        status: true,
        discontinueRequestedAt: true,
        user: { select: { name: true } },
        learner: { select: { name: true } },
        periods: { select: { startDate: true, endDate: true, discontinueEffectiveAt: true } },
        pauses: {
          where: { status: { in: ['approved', 'active', 'ended'] } },
          select: { startDate: true, endDate: true },
        },
      },
      orderBy: { startedAt: 'asc' },
    }),
  ]);

  // present rows keyed by (batch, learner, date) — absences are rows too, so a missing key means
  // "this session was never closed for them", not "absent".
  const presentAt = new Set<string>();
  for (const r of rows) {
    if (r.present) presentAt.add(`${r.batchId}:${r.learnerId}:${dateKey(r.date)}`);
  }

  for (const batchId of batchIds) {
    const batchSessions = sessions.filter((s) => s.batchId === batchId);
    const batchEnrollments = enrollments.filter((e) => e.batchId === batchId);
    // Only finalised held sessions count. `finalisedAt: null` on a held session is the
    // "not recorded" state (plan decision 6).
    const counted = batchSessions.filter((s) => s.status === 'held' && s.finalisedAt !== null);

    const sessionSummaries: SessionSummary[] = batchSessions.map((s) => {
      const expected = expectedLearnerIdsOn(batchEnrollments, s.sessionDate);
      const present = expected.filter((l) => presentAt.has(`${batchId}:${l}:${dateKey(s.sessionDate)}`)).length;
      return {
        batch_id: batchId,
        session_date: dateKey(s.sessionDate),
        status: s.status as 'held' | 'cancelled',
        recorded: s.status === 'held' && s.finalisedAt !== null,
        present,
        expected: expected.length,
      };
    });

    const perStudent: StudentStat[] = batchEnrollments.map((e) => {
      const mine = counted.filter((s) => isExpectedOn(e, s.sessionDate));
      const present = mine.filter((s) => presentAt.has(`${batchId}:${e.learnerId}:${dateKey(s.sessionDate)}`)).length;
      const pct = attendancePct(present, mine.length);
      return {
        learner_id: e.learnerId,
        user_id: e.userId,
        name: e.learner.name || e.user.name,
        batch_id: batchId,
        expected: mine.length,
        present,
        pct,
        tier: tierOf(pct),
        reason_tag: reasonTagFor(e, range, pct),
        left_on: leftOn(e),
      };
    });

    const totalExpected = perStudent.reduce((n, s) => n + s.expected, 0);
    const totalPresent = perStudent.reduce((n, s) => n + s.present, 0);

    out.set(batchId, {
      batch_id: batchId,
      // "students" = whoever the month actually concerned, not today's roster.
      students: perStudent.filter((s) => s.expected > 0).length,
      held: counted.length,
      cancelled: batchSessions.filter((s) => s.status === 'cancelled').length,
      not_recorded: batchSessions.filter((s) => s.status === 'held' && s.finalisedAt === null).length,
      avg_pct: totalExpected > 0 ? Math.round((totalPresent / totalExpected) * 100) : null,
      sessions: sessionSummaries,
      per_student: perStudent,
    });
  }

  return out;
}

export async function statsForBatch(batchId: string, range?: DateRange): Promise<BatchStats> {
  const map = await statsForBatches([batchId], range);
  return map.get(batchId)!;
}

/** The batches this SUBJECT may see, for L1 and the roll-up. */
export async function academyBatches(scope: BatchScope): Promise<(BatchInput & { title: string; name: string })[]> {
  return prisma.batch.findMany({
    where: { ...scope, status: { in: ['active', 'closing'] } },
    select: { id: true, title: true, name: true },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Sort for every student list: worst first, but never a no-signal row at the top — `New` students
 * (no percentage) sort last, since a false alarm is worse than a late one. Inside one percentage,
 * the bigger denominator wins (12/12 above 4/4), then name.
 */
export function sortStudents(rows: StudentStat[]): StudentStat[] {
  return [...rows].sort((a, b) => {
    if (a.pct === null && b.pct === null) return (a.name ?? '').localeCompare(b.name ?? '');
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    if (a.pct !== b.pct) return a.pct - b.pct;
    if (a.expected !== b.expected) return b.expected - a.expected;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}

type EnrollmentRow = ExpectationEnrollment & {
  status: string;
  user: { name: string | null };
};

function leftOn(e: EnrollmentRow): string | null {
  if (e.status === 'active') return null;
  const d = e.periods.map((p) => p.discontinueEffectiveAt).find((x): x is Date => !!x) ?? e.discontinueRequestedAt;
  return d ? dateKey(d) : null;
}

function reasonTagFor(e: EnrollmentRow, range: DateRange | undefined, pct: number | null): ReasonTag {
  if (leftOn(e)) return 'left';
  if (range) {
    const pausedInRange = e.pauses.some(
      (p) => p.startDate && p.endDate && p.startDate <= range.to && p.endDate >= range.from,
    );
    if (pausedInRange) return 'paused';
    if (e.startedAt >= range.from && e.startedAt <= range.to) {
      return pct === null ? 'new' : 'joined_this_month';
    }
  }
  return pct === null ? 'new' : null;
}
