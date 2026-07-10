import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { istWallClockToUtc } from '../../lib/ist.js';
import { nextTimingOccurrenceAfter } from '../batches/service.js';
import { extendPeriodEndDate } from '../enrollments/repo.js';
import { sendPushNotifications } from '../push/service.js';

// S3.4: cancel a class session. No Slot row exists (D1), so we CREATE a CancelledSession
// (unbilled marker + idempotency key) and, only when newly created, make each affected
// enrolment good: +1 SessionCredit (the count) AND extend its period to the next real class
// occurrence (the delivery). Idempotent — re-cancelling is a no-op (no double credit/extend).
export async function cancelSession(academyId: string, batchId: string, sessionDateStr: string) {
  const batch = await prisma.batch.findFirst({
    where: { id: batchId, academyId },
    include: { timings: true },
  });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  // The date must be a real timing occurrence on that weekday, and strictly in the future.
  const sessionDate = new Date(`${sessionDateStr}T00:00:00.000Z`);
  if (Number.isNaN(sessionDate.getTime())) throw new AppError('VALIDATION', 400, 'Invalid session date');
  const dow = sessionDate.getUTCDay();
  const timing = batch.timings.find((batchTiming) => batchTiming.dayOfWeek === dow);
  if (!timing) throw new AppError('VALIDATION', 400, 'No class scheduled on that day');
  const [hour, minute] = timing.startTime.split(':').map(Number);
  const sessionStart = istWallClockToUtc(sessionDateStr, hour, minute);
  if (sessionStart <= new Date()) {
    throw new AppError('VALIDATION', 400, 'Only a future session can be cancelled');
  }

  // Idempotency: if already cancelled, no-op (no double make-good).
  const existing = await prisma.cancelledSession.findUnique({
    where: { batchId_sessionDate: { batchId, sessionDate } },
  });
  if (existing) return { cancelled: true, affected_count: 0, already_cancelled: true };

  const recipientUserIds = await prisma.$transaction(async (tx) => {
    await tx.cancelledSession.create({
      data: { batchId, sessionDate, reason: 'cancelled', cancelledByAccountId: academyId },
    });

    const enrollments = await tx.enrollment.findMany({
      where: { batchId },
      include: {
        periods: {
          where: { status: { in: ['active', 'grace'] } },
          orderBy: { endDate: 'desc' },
          take: 1,
        },
      },
    });

    const now = new Date();
    const recipients = enrollments.filter(
      (enrollment) => enrollment.status === 'active' && (!enrollment.pausedUntil || enrollment.pausedUntil < now) && enrollment.periods.length > 0,
    );

    for (const enrollment of recipients) {
      const period = enrollment.periods[0];
      await tx.sessionCredit.create({
        data: { enrollmentId: enrollment.id, batchId, reason: 'class_cancelled' },
      });
      // Extend to the NEXT real class after the current endDate → exactly one make-good session.
      const nextOccurrence = nextTimingOccurrenceAfter(period.endDate, batch.timings);
      if (nextOccurrence) {
        const delta = nextOccurrence.getTime() - period.endDate.getTime();
        const newGracePeriodEnd = period.gracePeriodEnd ? new Date(period.gracePeriodEnd.getTime() + delta) : nextOccurrence;
        await extendPeriodEndDate(period.id, nextOccurrence, newGracePeriodEnd, tx);
      }
    }
    return recipients.map((enrollment) => enrollment.userId);
  });

  // Notify outside the transaction (best-effort).
  const dateLabel = sessionStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  await Promise.all(
    recipientUserIds.map((userId) =>
      sendPushNotifications({
        subjectId: userId,
        subjectRole: 'student',
        title: 'Class cancelled',
        body: `${batch.title} on ${dateLabel} is cancelled — we've added a make-good session, so your count is unchanged.`,
        data: { screen: 'classes' },
      }).catch(() => {}),
    ),
  );

  return { cancelled: true, affected_count: recipientUserIds.length };
}
