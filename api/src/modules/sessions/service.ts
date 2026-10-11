import { prisma } from '../../lib/prisma.js';
import { LEARNER_PUSH_SELECT, whose } from '../../lib/learner-access.js';
import { batchScopeById, type BatchScope } from '../../lib/scope.js';
import { AppError } from '../../lib/app-error.js';
import { istWallClockToUtc } from '../../lib/ist.js';
import { nextTimingOccurrenceAfter } from '../batches/service.js';
import { extendPeriodEndDate } from '../enrollments/repo.js';
import { sendPushNotifications } from '../push/service.js';

// S3.4: cancel a class session. No Slot row exists (D1), so we UPSERT the ClassSession to
// `cancelled` (unbilled marker + idempotency key) and, only when newly cancelled, make each
// affected enrolment good: +1 SessionCredit (the count) AND extend its period to the next real
// class occurrence (the delivery). Idempotent — re-cancelling is a no-op (no double credit/extend).
// The upsert (not create) matters: a ClassSession row may already exist for that date because the
// check-in QR was issued for it.
// `actorId` is the LOGIN that cancelled. It used to be handed the branch id, which meant
// `ClassSession.cancelledByAccountId` recorded a branch rather than a person — now that a brand
// has several logins that would make "who cancelled this class?" unanswerable. Resolved for
// display by lib/actor.ts, alongside the SYSTEM_MARKER the cron workers write.
export async function cancelSession(
  scope: BatchScope,
  batchId: string,
  sessionDateStr: string,
  actorId: string,
) {
  const batch = await prisma.batch.findFirst({
    where: batchScopeById(scope, batchId),
    include: { timings: true },
  });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  // The date must be a real timing occurrence on that weekday, and strictly in the future.
  const sessionDate = new Date(`${sessionDateStr}T00:00:00.000Z`);
  if (Number.isNaN(sessionDate.getTime())) throw new AppError('VALIDATION', 400, 'Invalid session date');
  const dow = sessionDate.getUTCDay();
  const timing = batch.timings.find((t) => t.dayOfWeek === dow);
  if (!timing) throw new AppError('VALIDATION', 400, 'No class scheduled on that day');
  const [hh, mm] = timing.startTime.split(':').map(Number);
  const sessionStart = istWallClockToUtc(sessionDateStr, hh, mm);
  if (sessionStart <= new Date()) {
    throw new AppError('VALIDATION', 400, 'Only a future session can be cancelled');
  }

  // Idempotency: if already cancelled, no-op (no double make-good).
  const existing = await prisma.classSession.findUnique({
    where: { batchId_sessionDate: { batchId, sessionDate } },
  });
  if (existing?.status === 'cancelled') {
    return { cancelled: true, affected_count: 0, already_cancelled: true };
  }

  const recipientUserIds = await prisma.$transaction(async (tx) => {
    const session = await tx.classSession.upsert({
      where: { batchId_sessionDate: { batchId, sessionDate } },
      create: {
        batchId,
        sessionDate,
        status: 'cancelled',
        reason: 'cancelled',
        cancelledByAccountId: actorId,
      },
      // A cancelled session is out of every denominator, so it must not stay finalised.
      update: {
        status: 'cancelled',
        reason: 'cancelled',
        cancelledByAccountId: actorId,
        finalisedAt: null,
      },
    });

    const enrollments = await tx.enrollment.findMany({
      where: { batchId },
      include: {
        learner: LEARNER_PUSH_SELECT,
        periods: {
          where: { status: { in: ['active', 'grace'] } },
          orderBy: { endDate: 'desc' },
          take: 1,
        },
      },
    });

    const now = new Date();
    const recipients = enrollments.filter(
      (e) => e.status === 'active' && (!e.pausedUntil || e.pausedUntil < now) && e.periods.length > 0,
    );

    for (const e of recipients) {
      const period = e.periods[0];
      await tx.sessionCredit.create({
        data: { enrollmentId: e.id, batchId, classSessionId: session.id, reason: 'class_cancelled' },
      });
      // Extend to the NEXT real class after the current endDate → exactly one make-good session.
      const next = nextTimingOccurrenceAfter(period.endDate, batch.timings);
      if (next) {
        const delta = next.getTime() - period.endDate.getTime();
        const newGrace = period.gracePeriodEnd ? new Date(period.gracePeriodEnd.getTime() + delta) : next;
        await extendPeriodEndDate(period.id, next, newGrace, tx);
      }
    }
    return recipients.map((e) => ({ userId: e.userId, learner: e.learner }));
  });

  // Notify outside the transaction (best-effort).
  const dateLabel = sessionStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  await Promise.all(
    // One push per enrolled learner, naming a child, so siblings' parents hear about each.
    recipientUserIds.map(({ userId, learner }) =>
      sendPushNotifications({
        subjectId: userId,
        subjectRole: 'student',
        title: 'Class cancelled',
        body: `${whose(learner)} ${batch.title} class on ${dateLabel} is cancelled — we've added a make-good session, so the count is unchanged.`,
        data: { screen: 'classes' },
      }).catch(() => {}),
    ),
  );

  return { cancelled: true, affected_count: recipientUserIds.length };
}
