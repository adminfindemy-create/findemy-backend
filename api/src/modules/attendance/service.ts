import { AppError } from '../../lib/app-error.js';
import { checkRateLimit } from '../../lib/otp-rate-limit.js';
import { prisma } from '../../lib/prisma.js';
import { batchScopeById, type BatchScope } from '../../lib/scope.js';
import { sessionDateIST, istDateKey } from '../../lib/ist.js';
import { issuableSessionAt, sessionWindowsBetween, sessionWindowsOn } from '../../lib/session-window.js';
import { classCode, codesMatch } from '../../lib/attendance-code.js';
import { isExpectedOn, type ExpectationEnrollment } from '../../lib/attendance-expectation.js';
import * as repo from './repo.js';

type AttendanceRecord = Awaited<ReturnType<typeof repo.getBatchAttendance>>[number];

// Kept for the roster serializer + attendance-serializer.test.
export function serializeAttendance(records: AttendanceRecord[]) {
  return {
    students: records.map((r) => ({
      learner_id: r.learnerId,
      user_id: r.userId,
      // The learner is who attended; for a child that is not the account holder.
      name: r.learner?.name || r.user.name,
      present: r.present,
    })),
  };
}

// The teacher marks a student present by entering that student's own attendance code.
//
// Replaces the QR (academy showed a code, students scanned it). The code is different for every
// class day and every learner (lib/attendance-code.ts), and the app is only handed it inside the
// window — 10 minutes before the class starts until it ends (lib/session-window.ts) — so a code
// seen once is no use for another class, and nobody can know it in advance.
export async function markPresentByOtp(
  scope: BatchScope,
  batchId: string,
  learnerId: string,
  otpCode: string,
) {
  const batch = await prisma.batch.findFirst({
    where: batchScopeById(scope, batchId),
    select: { mode: true, timings: true, title: true },
  });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.mode !== 'offline') {
    throw new AppError('VALIDATION', 400, 'Attendance codes are for in-studio batches only');
  }

  const window = issuableSessionAt(batch.timings);
  if (!window) {
    throw new AppError(
      'NOT_IN_SESSION',
      400,
      'No class is running right now — attendance opens 10 minutes before the class starts',
    );
  }

  const sessionDate = new Date(`${window.sessionDate}T00:00:00.000Z`);
  const existing = await prisma.classSession.findUnique({
    where: { batchId_sessionDate: { batchId, sessionDate } },
    select: { status: true },
  });
  if (existing?.status === 'cancelled') {
    throw new AppError('VALIDATION', 400, 'This class was cancelled');
  }

  // The student must be one this class actually expects — not merely enrolled at some point.
  const enrollments = await repo.getEnrollmentsForExpectation(batchId);
  const target = (enrollments as ExpectationEnrollment[]).find((e) => e.learnerId === learnerId);
  if (!target || !isExpectedOn(target, sessionDate)) {
    throw new AppError('NOT_ENROLLED', 403, 'This student is not expected at this class');
  }

  // Per student per session: a wrong code cannot be brute-forced across the class.
  if (checkRateLimit(`attend:${batchId}:${window.sessionDate}:${learnerId}`, 5, 10 * 60 * 1000)) {
    throw new AppError('RATE_LIMITED', 429, 'Too many attempts for this student');
  }

  const learner = await prisma.learner.findUnique({ where: { id: learnerId }, select: { name: true } });
  if (!learner) throw new AppError('NOT_FOUND', 404, 'Student not found');

  if (!codesMatch(classCode(learnerId, batchId, window.sessionDate), otpCode)) {
    throw new AppError('OTP_MISMATCH', 403, 'Wrong code');
  }

  await prisma.$transaction(async (tx) => {
    // Marking the first student IS the record that this class was held.
    await repo.ensureClassSession(batchId, sessionDate, tx);
    await repo.recordPresent(target, batchId, sessionDate, 'otp', tx);
  });
  return {
    present: true,
    learner_id: learnerId,
    user_id: target.userId,
    name: learner.name,
    session_date: window.sessionDate,
  };
}

/**
 * The guardian's view of a class code: the code while the window is open, otherwise when it next
 * opens. Only for the account that holds the enrollment, only for in-studio batches (online
 * classes mark attendance on join).
 */
export async function getClassCode(userId: string, enrollmentId: string, now: Date = new Date()) {
  const enrollment = await prisma.enrollment.findFirst({
    where: { id: enrollmentId, userId },
    select: { learnerId: true, batchId: true, status: true, batch: { select: { mode: true, timings: true } } },
  });
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  if (enrollment.batch.mode !== 'offline' || enrollment.status !== 'active') {
    return { code: null, session_date: null, closes_at: null, opens_at: null };
  }

  const window = issuableSessionAt(enrollment.batch.timings, now);
  if (window) {
    return {
      code: classCode(enrollment.learnerId, enrollment.batchId, window.sessionDate),
      session_date: window.sessionDate,
      closes_at: window.issueClosesAt.toISOString(),
      opens_at: window.issueOpensAt.toISOString(),
    };
  }
  // Next opening within the coming fortnight, so the app can say "opens in 2h".
  const from = istDateKey(now);
  const to = istDateKey(new Date(now.getTime() + 14 * 86_400_000));
  const next = sessionWindowsBetween(enrollment.batch.timings, from, to).find((w) => w.issueOpensAt > now);
  return { code: null, session_date: null, closes_at: null, opens_at: next ? next.issueOpensAt.toISOString() : null };
}

/** A register stays correctable for this long after the class ends. */
export const CORRECTION_WINDOW_HOURS = 24;

// Fix one student's attendance for one session, up to 24h after the class ended.
//
// Absence used to be final and uncorrectable (the QR expired before the closer ran, deliberately).
// It no longer is: teachers miss people, and a register nobody can fix is worse than one that can
// be. Two cases are handled, and the second is the one that matters most:
//
//   session already recorded   → flip that student present/absent
//   session NEVER recorded     → nobody's code was entered, so the closer wrote nothing and the
//                                whole class was lost. The first correction finalises it: every
//                                expected student is written absent, then this student is set.
//
// Also the "mark without a code" action during class: the row is then `method: manual` rather
// than `correction`. Neither ever claims a code was entered.
export async function correctAttendance(
  scope: BatchScope,
  batchId: string,
  dateStr: string,
  learnerId: string,
  present: boolean,
  accountId: string,
  reason?: string,
) {
  const batch = await prisma.batch.findFirst({
    where: batchScopeById(scope, batchId),
    select: { timings: true },
  });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  const windows = sessionWindowsOn(batch.timings, dateStr);
  if (windows.length === 0) {
    throw new AppError('VALIDATION', 400, 'This batch does not meet on that date');
  }
  // The last session of the day is the one the deadline runs from.
  const endsAt = windows[windows.length - 1].end;
  const deadline = new Date(endsAt.getTime() + CORRECTION_WINDOW_HOURS * 3600_000);
  const now = new Date();
  if (now > deadline) {
    throw new AppError('VALIDATION', 400, `Attendance can only be changed within ${CORRECTION_WINDOW_HOURS} hours of the class`);
  }
  if (now < windows[0].start) {
    throw new AppError('VALIDATION', 400, 'That class has not happened yet');
  }

  const sessionDate = new Date(`${dateStr}T00:00:00.000Z`);
  const session = await prisma.classSession.findUnique({
    where: { batchId_sessionDate: { batchId, sessionDate } },
    select: { status: true, finalisedAt: true },
  });
  if (session?.status === 'cancelled') {
    throw new AppError('VALIDATION', 400, 'This class was cancelled');
  }

  const enrollments = await repo.getEnrollmentsForExpectation(batchId);
  const expected = (enrollments as ExpectationEnrollment[]).filter((e) => isExpectedOn(e, sessionDate));
  const target = expected.find((e) => e.learnerId === learnerId);
  if (!target) {
    throw new AppError('NOT_ENROLLED', 403, 'This student is not expected at this class');
  }
  const method = now < endsAt ? 'manual' : 'correction';

  await prisma.$transaction(async (tx) => {
    await repo.ensureClassSession(batchId, sessionDate, tx);

    // Never recorded → write the absences the closer skipped, so the session stops reading as
    // "Not recorded" and starts counting in every denominator.
    if (!session?.finalisedAt) {
      for (const e of expected) {
        await tx.batchAttendance.upsert({
          where: { batchId_learnerId_date: { batchId, learnerId: e.learnerId, date: sessionDate } },
          update: {},
          create: {
            batchId,
            userId: e.userId,
            learnerId: e.learnerId,
            date: sessionDate,
            present: false,
            method: 'correction',
            markedByAccountId: accountId,
          },
        });
      }
      await tx.classSession.update({
        where: { batchId_sessionDate: { batchId, sessionDate } },
        data: { finalisedAt: new Date() },
      });
    }

    await tx.batchAttendance.upsert({
      where: { batchId_learnerId_date: { batchId, learnerId, date: sessionDate } },
      update: { present, method, reason: reason ?? null, markedByAccountId: accountId, markedAt: new Date() },
      create: {
        batchId,
        userId: target.userId,
        learnerId,
        date: sessionDate,
        present,
        method,
        reason: reason ?? null,
        markedByAccountId: accountId,
      },
    });
  });

  return {
    learner_id: learnerId,
    user_id: target.userId,
    date: dateStr,
    present,
    method,
    corrected_until: deadline.toISOString(),
  };
}

// S3.2/S3.3: live roster — who is expected at this session, split by whether they've checked in.
// The denominator is the expected set (not "all active enrolees"), so a student who joined next
// month or is on a pause doesn't sit in the not-yet list all class. Once the session has closed,
// `absent` is the written record: the not-yet column becomes the absence list.
export async function getSessionAttendance(scope: BatchScope, batchId: string, dateStr?: string) {
  // Tenant gate. This read is keyed only on a URL-supplied batch id, so the ownership check has
  // to happen here — same shape as issueCheckinToken above. Without it the roster (student names
  // and ids, plus the absence list) crosses the brand boundary.
  const batch = await prisma.batch.findFirst({ where: batchScopeById(scope, batchId), select: { id: true, timings: true } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  const date = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : sessionDateIST();
  const [enrollments, records, session] = await Promise.all([
    repo.getEnrollmentsForExpectation(batchId),
    repo.getBatchAttendance(batchId, date),
    prisma.classSession.findUnique({ where: { batchId_sessionDate: { batchId, sessionDate: date } } }),
  ]);
  const present = new Map(records.filter((r) => r.present).map((r) => [r.learnerId, r.markedAt]));
  const expected = (
    enrollments as (ExpectationEnrollment & { user: { name: string | null }; learner: { name: string } })[]
  ).filter((e) => isExpectedOn(e, date));
  // One row per learner: siblings in the same batch are separate rows with separate codes.
  // `user_id` is the guardian account, kept for older academy-app builds.
  const roster = expected.map((e) => ({
    learner_id: e.learnerId,
    user_id: e.userId,
    name: e.learner.name || e.user.name,
    guardian_name: e.user.name,
    checked_in: present.has(e.learnerId),
    marked_at: present.get(e.learnerId)?.toISOString(),
  }));
  // When this session ended — the client needs it to know whether the 24h correction window
  // is still open. Null on a date the batch does not meet.
  const windows = sessionWindowsOn(batch.timings, istDateKey(date));
  return {
    // The IST day this register is for — the key a manual mark or correction is sent against.
    session_date: istDateKey(date),
    session_end_at: windows.length ? windows[windows.length - 1].end.toISOString() : null,
    present_count: roster.filter((r) => r.checked_in).length,
    total: roster.length,
    // null while the session is open; true/false once it closed (false = "not recorded").
    recorded: session ? session.status === 'held' && session.finalisedAt !== null : null,
    status: session?.status ?? null,
    roster,
    absent: roster.filter((r) => !r.checked_in).map(({ learner_id, user_id, name }) => ({ learner_id, user_id, name })),
  };
}
