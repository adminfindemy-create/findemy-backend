import { prisma } from '../../lib/prisma.js';

export async function getBatchAttendance(batchId: string, date: Date) {
  return prisma.batchAttendance.findMany({
    where: { batchId, date },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      learner: { select: { id: true, name: true } },
    },
  });
}

// S3.2/S3.3: the shared "mark present" write. Used by the attendance code (in-studio, method
// 'otp') AND online auto-on-join (method 'auto'). `markedByAccountId` is null (student-driven /
// auto). Idempotent on (batch,learner,date). `userId` is the enrolling account, kept on the row.
export async function recordPresent(
  student: { userId: string; learnerId: string },
  batchId: string,
  date: Date,
  method: 'otp' | 'auto',
  tx?: any,
) {
  const db = tx ?? prisma;
  const { userId, learnerId } = student;
  return db.batchAttendance.upsert({
    where: { batchId_learnerId_date: { batchId, learnerId, date } },
    create: { batchId, userId, learnerId, date, present: true, method, markedByAccountId: null, markedAt: new Date() },
    update: { present: true, method, markedAt: new Date() },
  });
}

/**
 * "A class happened on this day" — written the moment the first attendance signal exists (QR
 * issued, or an online student joined). Never flips a cancelled session back to held: cancelling
 * is a deliberate academy statement and outranks a stray check-in.
 */
export async function ensureClassSession(batchId: string, sessionDate: Date, tx?: any) {
  const db = tx ?? prisma;
  return db.classSession.upsert({
    where: { batchId_sessionDate: { batchId, sessionDate } },
    create: { batchId, sessionDate, status: 'held' },
    update: {},
  });
}

/**
 * Every enrolment of a batch with the facts `isExpectedOn` needs. Not filtered by status: past
 * sessions of a student who has since left are still part of that month's denominator.
 * Approved/active/ended pauses only — a pending or rejected pause never happened.
 */
export async function getEnrollmentsForExpectation(batchId: string, tx?: any) {
  const db = tx ?? prisma;
  return db.enrollment.findMany({
    where: { batchId },
    select: {
      userId: true,
      learnerId: true,
      startedAt: true,
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
  });
}

// Active enrolees of a batch — the roster denominator.
export async function getActiveEnrollees(batchId: string) {
  return prisma.enrollment.findMany({
    where: { batchId, status: 'active' },
    select: { userId: true, learnerId: true, user: { select: { name: true } }, learner: { select: { name: true } } },
    orderBy: { startedAt: 'asc' },
  });
}
