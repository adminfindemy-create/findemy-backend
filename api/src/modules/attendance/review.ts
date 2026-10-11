// The academy's attendance REVIEW surfaces (L1 → L3b + CSV). Taking attendance is the QR screen;
// this is reading it back. Every number here comes from stats.ts, and every screen shares one
// window — a calendar month — so the same batch can never show two different percentages on two
// adjacent screens. See ai-usage/attendance-tracking_plan.md decisions 8 and 12.
import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { batchScopeById, type BatchScope } from '../../lib/scope.js';
import { istDateKey } from '../../lib/ist.js';
import { toWireMode } from '../../lib/mode.js';
import { sessionWindowsOn } from '../../lib/session-window.js';
import { attendancePct, tierOf } from '../../lib/attendance-tier.js';
import { isExpectedOn } from '../../lib/attendance-expectation.js';
import {
  monthRange,
  sortStudents,
  statsForBatch,
  statsForBatches,
  type BatchStats,
  type DateRange,
  type StudentStat,
} from './stats.js';
import { learnerIdFromStudentRef } from '../../lib/learner-access.js';

/** Current IST month, the default window for every screen. */
function currentMonth(): string {
  return istDateKey(new Date()).slice(0, 7);
}

function parseMonth(month?: string): { month: string; range: DateRange } {
  const m = month ?? currentMonth();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new AppError('VALIDATION', 400, 'month must be YYYY-MM');
  try {
    return { month: m, range: monthRange(m) };
  } catch {
    throw new AppError('VALIDATION', 400, 'month must be YYYY-MM');
  }
}

// The single ownership gate for every L2/L3 read. Scoped, so a teacher asking for another
// coach's batch id gets the same 404 as a batch from another brand — no distinguishable answer.
async function ownedBatch(batchId: string, scope: BatchScope) {
  const batch = await prisma.batch.findFirst({
    where: batchScopeById(scope, batchId),
    select: { id: true, title: true, name: true, mode: true, timings: true },
  });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  return batch;
}

/** A student row the month didn't concern at all is noise, not a zero. */
function monthRoster(stats: BatchStats): StudentStat[] {
  return sortStudents(stats.per_student.filter((s) => s.expected > 0 || s.present > 0));
}

/** 'HH:mm' IST start of a session, from the batch's timetable. Null if the timetable has moved. */
function startTimeOf(dateStr: string, timings: { dayOfWeek: number; startTime: string; durationMin: number }[]) {
  const windows = sessionWindowsOn(timings, dateStr);
  return windows.length ? windows[0].start.toISOString() : null;
}

// ---------- L1: every PROGRAM, one month ----------
//
// Grouped by program, not batch: "Guitar" is the thing the academy runs, and its batches are
// variants of it (Weekday Evening, Kids Weekend). A flat batch list made an academy with three
// programs × three batches read as nine unrelated rows. The batches come nested so the program
// screen's picker needs no second request, and each carries its own month figures.

export async function getAttendanceOverview(scope: BatchScope, month?: string, q?: string) {
  const { month: m, range } = parseMonth(month);
  const batches = await prisma.batch.findMany({
    where: {
      ...scope,
      status: { in: ['active', 'closing'] },
      // Search matches the program's title as well as the batch label — an academy types
      // "guitar" (a program) at least as often as "weekend" (a batch).
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
              { program: { title: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      title: true,
      name: true,
      mode: true,
      programId: true,
      // Cover photo + category so the row reads like the Programs list (same 52px thumb, same
      // coloured-initial fallback) — one visual language for "a program" across the app.
      program: {
        select: {
          id: true,
          title: true,
          level: true,
          category: true,
          media: { orderBy: { order: 'asc' }, take: 1, select: { url: true } },
        },
      },
    },
    orderBy: [{ title: 'asc' }, { name: 'asc' }],
  });
  const stats = await statsForBatches(batches.map((b) => b.id), range);

  const summaryOf = (batchId: string) => {
    const s = stats.get(batchId)!;
    return {
      students: s.students,
      held: s.held,
      cancelled: s.cancelled,
      not_recorded: s.not_recorded,
      avg_pct: s.avg_pct,
    };
  };

  // Preserve the query's ordering (program title, then batch label) while grouping.
  const order: string[] = [];
  const byProgram = new Map<string, typeof batches>();
  for (const b of batches) {
    if (!byProgram.has(b.programId)) {
      byProgram.set(b.programId, []);
      order.push(b.programId);
    }
    byProgram.get(b.programId)!.push(b);
  }

  const programs = order.map((programId) => {
    const rows = byProgram.get(programId)!;
    const program = rows[0].program;

    // Program totals are computed from per-student rows, not by averaging the batches'
    // percentages: a 4-student batch must not weigh the same as a 28-student one. Students are
    // counted DISTINCT — one person in two batches of the same program is one student.
    const studentIds = new Set<string>();
    let present = 0;
    let expected = 0;
    for (const b of rows) {
      for (const st of stats.get(b.id)!.per_student) {
        if (st.expected > 0) studentIds.add(st.learner_id);
        present += st.present;
        expected += st.expected;
      }
    }

    return {
      program_id: programId,
      title: program.title,
      level: program.level,
      category: program.category,
      cover_url: program.media[0]?.url ?? null,
      students: studentIds.size,
      batch_count: rows.length,
      held: rows.reduce((n, b) => n + stats.get(b.id)!.held, 0),
      cancelled: rows.reduce((n, b) => n + stats.get(b.id)!.cancelled, 0),
      not_recorded: rows.reduce((n, b) => n + stats.get(b.id)!.not_recorded, 0),
      avg_pct: expected > 0 ? Math.round((present / expected) * 100) : null,
      batches: rows.map((b) => ({
        batch_id: b.id,
        title: b.title,
        name: b.name,
        mode: toWireMode(b.mode),
        ...summaryOf(b.id),
      })),
    };
  });

  return { month: m, programs };
}

// ---------- L2: one batch, one month — sessions AND students, no matrix ----------

export async function getBatchAttendance(scope: BatchScope, batchId: string, month?: string) {
  const { month: m, range } = parseMonth(month);
  const batch = await ownedBatch(batchId, scope);
  const stats = await statsForBatch(batchId, range);
  const roster = monthRoster(stats);

  return {
    month: m,
    batch: { id: batch.id, title: batch.title, name: batch.name },
    students: stats.students,
    held: stats.held,
    cancelled: stats.cancelled,
    not_recorded: stats.not_recorded,
    avg_pct: stats.avg_pct,
    // The section header's own alarm, phrased at the Active boundary so the number and the badge
    // speak one language.
    below_threshold: roster.filter((s) => s.pct !== null && s.pct < 75).length,
    sessions: stats.sessions.map((s) => ({
      session_date: s.session_date,
      start_time: startTimeOf(s.session_date, batch.timings),
      status: s.status,
      recorded: s.recorded,
      present: s.present,
      expected: s.expected,
    })),
    // Worst first, `New` last — see sortStudents.
    students_list: roster,
  };
}

// ---------- L3a: one session ----------

export async function getSessionDetail(scope: BatchScope, batchId: string, dateStr: string) {
  const batch = await ownedBatch(batchId, scope);
  return getSessionDetailFor(batch, dateStr);
}

async function getSessionDetailFor(
  batch: { id: string; title: string; name: string; timings: { dayOfWeek: number; startTime: string; durationMin: number }[] },
  dateStr: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new AppError('VALIDATION', 400, 'date must be YYYY-MM-DD');
  const sessionDate = new Date(`${dateStr}T00:00:00.000Z`);

  const [session, rows, enrollments] = await Promise.all([
    prisma.classSession.findUnique({ where: { batchId_sessionDate: { batchId: batch.id, sessionDate } } }),
    prisma.batchAttendance.findMany({
      where: { batchId: batch.id, date: sessionDate },
      select: {
        learnerId: true,
        userId: true,
        present: true,
        markedAt: true,
        user: { select: { name: true } },
        learner: { select: { name: true } },
      },
    }),
    prisma.enrollment.findMany({
      where: { batchId: batch.id },
      select: {
        userId: true,
        learnerId: true,
        startedAt: true,
        discontinueRequestedAt: true,
        user: { select: { name: true } },
        learner: { select: { name: true } },
        periods: { select: { startDate: true, endDate: true, discontinueEffectiveAt: true } },
        pauses: { where: { status: { in: ['approved', 'active', 'ended'] } }, select: { startDate: true, endDate: true } },
      },
    }),
  ]);
  // No ClassSession row is a STATE, not an error: it means nothing ever recorded that day — the
  // QR was never shown, nobody joined. 404 is reserved for a date the batch never meets, which is
  // a bad link rather than an unrecorded class.
  if (!session && sessionWindowsOn(batch.timings, dateStr).length === 0) {
    throw new AppError('NOT_FOUND', 404, 'This batch has no class on that date');
  }

  // Keyed by learner: siblings in one batch are separate people. `user_id` is the guardian account.
  const present = rows
    .filter((r) => r.present)
    .map((r) => ({
      learner_id: r.learnerId,
      user_id: r.userId,
      name: r.learner.name || r.user.name,
      marked_at: r.markedAt.toISOString(),
    }))
    .sort((a, b) => a.marked_at.localeCompare(b.marked_at));

  // Absentees come from the written rows when the session was closed; before that, from who was
  // expected — so a live session shows "not yet" rather than a premature absence.
  const presentIds = new Set(present.map((p) => p.learner_id));
  const absent = session?.finalisedAt
    ? rows
        .filter((r) => !r.present)
        .map((r) => ({ learner_id: r.learnerId, user_id: r.userId, name: r.learner.name || r.user.name }))
    : enrollments
        .filter((e) => isExpectedOn(e, sessionDate) && !presentIds.has(e.learnerId))
        .map((e) => ({ learner_id: e.learnerId, user_id: e.userId, name: e.learner.name || e.user.name }));

  return {
    batch: { id: batch.id, title: batch.title, name: batch.name },
    session_date: dateStr,
    start_time: startTimeOf(dateStr, batch.timings),
    status: (session?.status ?? 'held') as 'held' | 'cancelled',
    // A held session with no check-ins is "Not recorded", not "everyone absent". Same for a
    // session that has no row at all.
    recorded: session?.status === 'held' && session.finalisedAt !== null,
    reason: session?.reason ?? null,
    present_count: present.length,
    absent_count: absent.length,
    present,
    absent,
  };
}

// ---------- L3b: one student, one month ----------

// `studentId` is a learner id; older academy-app builds pass the account's user id, which maps to
// that account's own learner.
export async function getStudentAttendance(scope: BatchScope, studentId: string, month?: string) {
  const { month: m, range } = parseMonth(month);
  const learnerId = await learnerIdFromStudentRef({ user_id: studentId });

  const [learner, enrollments] = await Promise.all([
    prisma.learner.findUnique({ where: { id: learnerId }, select: { id: true, name: true } }),
    prisma.enrollment.findMany({
      // Already 404s below when this comes back empty, so scoping it also gives a teacher the
      // right answer for a student who exists but is in none of their batches.
      where: { learnerId, batch: scope },
      select: {
        userId: true,
        learnerId: true,
        user: { select: { name: true, phone: true } },
        batchId: true,
        startedAt: true,
        discontinueRequestedAt: true,
        batch: { select: { id: true, title: true, name: true, timings: true } },
        periods: {
          select: { startDate: true, endDate: true, discontinueEffectiveAt: true, status: true, amountPaise: true },
          orderBy: { endDate: 'desc' },
        },
        pauses: { where: { status: { in: ['approved', 'active', 'ended'] } }, select: { startDate: true, endDate: true } },
      },
    }),
  ]);
  if (!learner || enrollments.length === 0) throw new AppError('NOT_FOUND', 404, 'Student not found');
  // The phone on file is the guardian's: a child has no login of their own.
  const guardian = enrollments[0].user;

  const batchIds = enrollments.map((e) => e.batchId);
  const [monthStats, sessions, rows] = await Promise.all([
    statsForBatches(batchIds, range),
    prisma.classSession.findMany({
      where: { batchId: { in: batchIds }, sessionDate: { gte: range.from, lte: range.to } },
      orderBy: { sessionDate: 'desc' },
    }),
    prisma.batchAttendance.findMany({
      where: { learnerId, batchId: { in: batchIds }, date: { gte: range.from, lte: range.to } },
      select: { batchId: true, date: true, present: true, markedAt: true },
    }),
  ]);

  const rowFor = new Map(rows.map((r) => [`${r.batchId}:${istDateKey(r.date)}`, r]));
  const titleOf = new Map(enrollments.map((e) => [e.batchId, `${e.batch.title} — ${e.batch.name}`]));
  const enrollmentOf = new Map(enrollments.map((e) => [e.batchId, e]));

  const days = sessions
    .filter((s) => {
      const e = enrollmentOf.get(s.batchId)!;
      // Cancellations are shown even when the student wasn't expected — it explains a gap.
      return s.status === 'cancelled' || isExpectedOn(e, s.sessionDate);
    })
    .map((s) => {
      const key = `${s.batchId}:${istDateKey(s.sessionDate)}`;
      const row = rowFor.get(key);
      const state =
        s.status === 'cancelled'
          ? 'cancelled'
          : s.finalisedAt === null
            ? 'not_recorded'
            : row?.present
              ? 'present'
              : 'absent';
      return {
        session_date: istDateKey(s.sessionDate),
        batch_id: s.batchId,
        batch_title: titleOf.get(s.batchId) ?? null,
        start_time: startTimeOf(istDateKey(s.sessionDate), enrollmentOf.get(s.batchId)!.batch.timings),
        state,
        marked_at: state === 'present' ? row?.markedAt.toISOString() ?? null : null,
      };
    });

  let present = 0;
  let expected = 0;
  for (const batchId of batchIds) {
    const stat = monthStats.get(batchId)?.per_student.find((s) => s.learner_id === learnerId);
    present += stat?.present ?? 0;
    expected += stat?.expected ?? 0;
  }

  return {
    month: m,
    student: {
      id: learner.id,
      learner_id: learner.id,
      user_id: enrollments[0].userId,
      name: learner.name || guardian.name,
      phone: guardian.phone,
      guardian_name: guardian.name,
    },
    present,
    expected,
    pct: attendancePct(present, expected),
    tier: tierOf(attendancePct(present, expected)),
    // Money is the subject on this screen, so the paid period appears alongside the month.
    current_period: await currentPeriodFigure(learnerId, enrollments),
    days,
  };
}

/** "This term (paid): 19 of 30" — the same counting, over the current period instead of a month. */
async function currentPeriodFigure(
  learnerId: string,
  enrollments: { batchId: string; periods: { startDate: Date; endDate: Date; status: string }[] }[],
) {
  const current = enrollments
    .map((e) => ({ batchId: e.batchId, period: e.periods.find((p) => p.status === 'active' || p.status === 'grace') }))
    .filter((x): x is { batchId: string; period: { startDate: Date; endDate: Date; status: string } } => !!x.period);
  if (current.length === 0) return null;

  let present = 0;
  let expected = 0;
  let start: Date | null = null;
  let end: Date | null = null;
  for (const { batchId, period } of current) {
    const stats = await statsForBatch(batchId, { from: period.startDate, to: period.endDate });
    const stat = stats.per_student.find((s) => s.learner_id === learnerId);
    present += stat?.present ?? 0;
    expected += stat?.expected ?? 0;
    if (!start || period.startDate < start) start = period.startDate;
    if (!end || period.endDate > end) end = period.endDate;
  }
  return {
    present,
    expected,
    start_date: start ? istDateKey(start) : null,
    end_date: end ? istDateKey(end) : null,
  };
}

// ---------- CSV: the matrix, on a screen wide enough for it ----------

export async function getBatchAttendanceCsv(scope: BatchScope, batchId: string, month?: string) {
  const { month: m, range } = parseMonth(month);
  const batch = await ownedBatch(batchId, scope);
  const stats = await statsForBatch(batchId, range);
  const roster = monthRoster(stats);

  // Oldest first reads better in a spreadsheet than the app's newest-first list.
  const sessions = [...stats.sessions].sort((a, b) => a.session_date.localeCompare(b.session_date));
  const rows = await prisma.batchAttendance.findMany({
    where: { batchId, date: { gte: range.from, lte: range.to } },
    select: { learnerId: true, date: true, present: true },
  });
  const state = new Map(rows.map((r) => [`${r.learnerId}:${istDateKey(r.date)}`, r.present]));
  // A child's parent, so the sheet says whom to call. Blank for adults learning for themselves.
  const accounts = await prisma.user.findMany({
    where: { id: { in: [...new Set(roster.map((s) => s.user_id))] } },
    select: { id: true, name: true },
  });
  const accountName = new Map(accounts.map((u) => [u.id, u.name ?? '']));

  const header = ['Student', 'Parent', 'Present', 'Expected', '%', ...sessions.map((s) => s.session_date)];
  const lines = [header.join(',')];
  for (const s of roster) {
    const cells = sessions.map((sess) => {
      if (sess.status === 'cancelled') return 'cancelled';
      if (!sess.recorded) return 'not recorded';
      const v = state.get(`${s.learner_id}:${sess.session_date}`);
      if (v === undefined) return '-'; // wasn't expected that day (joined later, paused, left)
      return v ? 'P' : 'A';
    });
    const parent = accountName.get(s.user_id) ?? '';
    lines.push(
      [csv(s.name ?? ''), csv(parent === s.name ? '' : parent), s.present, s.expected, s.pct ?? '', ...cells].join(','),
    );
  }

  const filename = `${batch.title}-${batch.name}-${m}-attendance.csv`.replace(/[^\w.-]+/g, '-');
  return { filename, csv: lines.join('\n') + '\n' };
}

function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
