import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { sendPushNotifications } from '../push/service.js';
import * as enrollRepo from '../enrollments/repo.js';
import * as repo from './repo.js';

// Plan §7: minimum 30-day notice before a batch can be fully discontinued.
export const DISCONTINUE_NOTICE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type Blocker = {
  enrollment_id: string;
  user_id: string;
  student_name: string | null;
  paid_through: string; // ISO endDate the student is served out to
  package_type: string;
  amount_paise: number;
};

// Active enrolments whose current paid period ends in the future = discontinuation blockers.
// Served-out students (no future period) are not blockers.
function computeBlockers(
  enrollments: Awaited<ReturnType<typeof repo.getActiveEnrollmentsWithPeriods>>,
  now: Date,
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const e of enrollments) {
    const future = e.periods.find((p) => p.endDate && p.endDate > now);
    if (!future) continue;
    blockers.push({
      enrollment_id: e.id,
      user_id: e.user.id,
      student_name: e.user.name,
      paid_through: future.endDate!.toISOString(),
      package_type: future.packageType,
      amount_paise: future.amountPaise,
    });
  }
  return blockers;
}

export async function discontinueBatch(batchId: string, academyId: string) {
  const batch = await repo.getBatchForAcademy(batchId, academyId);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.status === 'closing' || batch.status === 'ended') {
    throw new AppError('CONFLICT', 409, 'Batch is already being discontinued');
  }
  if (batch.status !== 'active') {
    throw new AppError('VALIDATION', 400, 'Only an active batch can be discontinued');
  }

  const now = new Date();
  // Immediate effect: closing → removed from discovery + blocks new trials/enrol/renew
  // (enforced by the existing `status === 'active'` guards).
  await repo.setBatchStatus(batchId, 'closing', now);

  // Cancel booked, upcoming trials + refund their (captured) trial fee. Trial refunds are
  // Findemy-neutral (plan §11) — full refund + standard commission reversal, no reserve impact.
  const cancelledTrials = await repo.cancelBookedFutureTrials(batchId, now);
  const trialPayments = await repo.getCapturedTrialPayments(
    cancelledTrials.map((t) => t.bookingId).filter((b): b is string => !!b),
  );
  if (trialPayments.length > 0) {
    const { issueRazorpayRefund } = await import('../payments/service.js');
    const { updatePaymentRefunded, reverseCommission } = await import('../payments/repo.js');
    for (const p of trialPayments) {
      if (!p.razorpayPaymentId || p.amountPaise <= 0) continue;
      try {
        const refundId = await issueRazorpayRefund(p.razorpayPaymentId, p.amountPaise);
        await updatePaymentRefunded(p.id, refundId, p.amountPaise);
        await reverseCommission('trial', p.bookingId!, p.amountPaise);
      } catch { /* reconcile worker retries */ }
    }
  }
  await repo.cancelPendingPauses(batchId, now);

  // Notify enrolled students + trial students (best-effort).
  const enrolledIds = await repo.getActiveEnrolledUserIds(batchId);
  const notifyIds = Array.from(new Set([...enrolledIds, ...cancelledTrials.map((t) => t.userId)]));
  await Promise.all(
    notifyIds.map((userId) =>
      sendPushNotifications({
        subjectId: userId,
        subjectRole: 'student',
        title: 'Class being discontinued',
        body: `${batch.title} is being discontinued. You're covered until the end of the term you've paid for.`,
        data: { screen: 'classes' },
      }).catch(() => {}),
    ),
  );

  return {
    status: 'closing',
    cancelled_trials: cancelledTrials.length,
    notified: notifyIds.length,
  };
}

export async function getBatchDiscontinuation(batchId: string, academyId: string) {
  const batch = await repo.getBatchForAcademy(batchId, academyId);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  const now = new Date();
  const enrollments = await repo.getActiveEnrollmentsWithPeriods(batchId);
  const blockers = computeBlockers(enrollments, now);

  const requestedAt = batch.discontinueRequestedAt;
  const daysElapsed = requestedAt ? Math.floor((now.getTime() - requestedAt.getTime()) / DAY_MS) : 0;
  const noticeDaysRemaining = requestedAt ? Math.max(0, DISCONTINUE_NOTICE_DAYS - daysElapsed) : DISCONTINUE_NOTICE_DAYS;

  // 30-day floor is skipped for a batch with no active enrolments (nobody to protect).
  const noticeCleared = enrollments.length === 0 || daysElapsed >= DISCONTINUE_NOTICE_DAYS;
  const blockersCleared = blockers.length === 0;
  const can_finish = batch.status === 'closing' && noticeCleared && blockersCleared;

  return {
    batch_id: batch.id,
    batch_title: batch.title,
    status: batch.status,
    discontinue_requested_at: requestedAt?.toISOString() ?? null,
    notice_days_remaining: batch.status === 'closing' ? noticeDaysRemaining : 0,
    active_enrollments: enrollments.length,
    blockers,
    can_finish,
  };
}

// Count weekly class sessions in [from, to] given the batch's timings (day-of-week 0–6 = getDay()).
function countSessions(daysOfWeek: number[], from: Date, to: Date): number {
  if (to <= from || daysOfWeek.length === 0) return 0;
  const days = new Set(daysOfWeek);
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  let guard = 0;
  while (d <= end && guard < 1000) {
    if (days.has(d.getDay())) count++;
    d.setDate(d.getDate() + 1);
    guard++;
  }
  return count;
}

// Pro-rated refund of the unconsumed portion of the current paid period, by remaining sessions
// (plan §8): amountPaise × sessions_remaining / sessions_in_period (calendar-day fallback).
function computeRefundPaise(
  amountPaise: number,
  startDate: Date,
  endDate: Date,
  daysOfWeek: number[],
  now: Date,
): number {
  if (now >= endDate) return 0;
  const totalSessions = countSessions(daysOfWeek, startDate, endDate);
  const remainingSessions = countSessions(daysOfWeek, now, endDate);
  if (totalSessions > 0) {
    return Math.floor((amountPaise * Math.min(remainingSessions, totalSessions)) / totalSessions);
  }
  // Calendar-day fallback.
  const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MS);
  const remainingDays = Math.floor((endDate.getTime() - now.getTime()) / DAY_MS);
  if (totalDays <= 0) return 0;
  return Math.floor((amountPaise * Math.max(0, Math.min(remainingDays, totalDays))) / totalDays);
}

// Refund a blocking student to accelerate discontinuation. Pro-rated by remaining sessions,
// issued via Razorpay; the enrolment is then resolved (period cancelled, enrolment inactive)
// so it drops out of the blocking set. Per plan §9 the academy bears the full gross — commission
// is NOT reversed here (Slice 7 books the recoverable against the academy).
export async function refundBlockerEnrollment(batchId: string, enrollmentId: string, academyId: string) {
  const batch = await repo.getBatchForAcademy(batchId, academyId);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.status !== 'closing') {
    throw new AppError('VALIDATION', 400, 'Batch is not being discontinued');
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: { id: enrollmentId, batchId, status: 'active' },
    include: { batch: { include: { timings: true } } },
  });
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Active enrolment not found on this batch');

  const period: any = await enrollRepo.findActivePeriod(enrollmentId);
  const now = new Date();

  let refundAmountPaise = 0;
  let razorpayRefundId: string | null = null;

  if (period && new Date(period.endDate) > now) {
    const daysOfWeek = enrollment.batch.timings.map((t) => t.dayOfWeek);
    refundAmountPaise = computeRefundPaise(
      period.amountPaise,
      new Date(period.startDate),
      new Date(period.endDate),
      daysOfWeek,
      now,
    );

    // Issue the Razorpay refund when there's a captured payment to refund against.
    if (refundAmountPaise >= 100 && period.payment?.status === 'captured' && period.payment.razorpayPaymentId) {
      const { issueRazorpayRefund } = await import('../payments/service.js');
      const { updateEnrollmentPaymentRefunded } = await import('../payments/repo.js');
      razorpayRefundId = await issueRazorpayRefund(period.payment.razorpayPaymentId, refundAmountPaise);
      await updateEnrollmentPaymentRefunded(period.payment.id, razorpayRefundId, refundAmountPaise);
      // Plan §9: commission is NOT reversed — the academy bears the full gross. Book the recoverable
      // against the academy (reserve drawn first, remainder → negative balance netted from payouts).
      const { applyRefundRecovery } = await import('../settlement/service.js');
      await applyRefundRecovery({
        academyId,
        grossPaise: refundAmountPaise,
        sourceType: 'enrollment_refund',
        sourceId: period.id,
      });
    }

    // Resolve the enrolment so it stops blocking: cancel the period + deactivate the enrolment.
    await prisma.$transaction(async (tx: any) => {
      await enrollRepo.setEnrollmentPeriodCancelled(period.id, tx);
      await enrollRepo.setEnrollmentInactive(enrollmentId, tx);
    });
  } else {
    // No future paid term — already served out; just deactivate.
    await enrollRepo.setEnrollmentInactive(enrollmentId);
  }

  // Notify the student (best-effort).
  await sendPushNotifications({
    subjectId: enrollment.userId,
    subjectRole: 'student',
    title: 'Refund issued',
    body: `${batch.title} has been discontinued. We've refunded the unused part of your term.`,
    data: { screen: 'classes' },
  }).catch(() => {});

  return { refunded: true, refund_amount_paise: refundAmountPaise, razorpay_refund_id: razorpayRefundId };
}

export async function finishDiscontinuation(batchId: string, academyId: string) {
  const info = await getBatchDiscontinuation(batchId, academyId);
  if (info.status !== 'closing') {
    throw new AppError('VALIDATION', 400, 'Batch is not being discontinued');
  }
  if (!info.can_finish) {
    if (info.blockers.length > 0) {
      throw new AppError('CONFLICT', 409, 'Some students still have a paid term — serve out or refund them first');
    }
    throw new AppError('CONFLICT', 409, `Minimum notice period not met (${info.notice_days_remaining} days remaining)`);
  }
  await repo.setBatchStatus(batchId, 'ended');
  return { status: 'ended' };
}
