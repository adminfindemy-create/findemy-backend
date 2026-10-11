import crypto from 'node:crypto';
import { PLAN_MONTHS, DISCOUNT_BPS_CAP, type Plan } from '@findemy/types';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import * as repo from './repo.js';
import { batchScopeById, type BatchScope } from '../../lib/scope.js';
import { sendPushNotifications } from '../push/service.js';
import { assertLearnerFitsBatch, resolveLearner, whose } from '../../lib/learner-access.js';
import {
  creditPauseCoverage,
  pauseAllowanceWeeks,
  pauseDurationDays,
  pauseWeeksForDuration,
} from '../../lib/pause.js';

// S2.3: months come from the shared contract; the discount % comes from the BATCH's
// academy-set quarterly/annual bps (S1.3), capped at 30%. `biannual` is dropped.
type PackageType = Plan;
type BatchDiscount = { quarterlyDiscountBps: number; annualDiscountBps: number };

function discountBpsFor(plan: Plan, batch: BatchDiscount): number {
  const bps = plan === 'quarterly' ? batch.quarterlyDiscountBps : plan === 'annual' ? batch.annualDiscountBps : 0;
  return Math.min(bps, DISCOUNT_BPS_CAP);
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toDateOnly(date: Date): Date {
  return new Date(date.toISOString().split('T')[0] + 'T00:00:00.000Z');
}

function computeAmount(monthlyFeePaise: number, plan: Plan, batch: BatchDiscount) {
  const months = PLAN_MONTHS[plan];
  const gross = monthlyFeePaise * months;
  const discount = Math.floor((gross * discountBpsFor(plan, batch)) / 10000);
  return gross - discount;
}

let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID || '', key_secret: env.RAZORPAY_KEY_SECRET || '' });
  return razorpayInstance;
}

async function createRazorpayOrder(enrollmentPeriodId: string, amountPaise: number, enrollmentId: string) {
  let razorpayOrderId = `order_enr_${newId().slice(0, 12)}`;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const rp = await getRazorpay();
    const order = await rp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: enrollmentPeriodId,
      notes: { enrollment_period_id: enrollmentPeriodId, enrollment_id: enrollmentId, payment_type: 'enrollment' },
    });
    razorpayOrderId = order.id;
  }
  return razorpayOrderId;
}

export function getRenewalOptions(batch: { monthlyFeePaise: number } & BatchDiscount) {
  return (Object.keys(PLAN_MONTHS) as Plan[]).map((plan) => {
    const months = PLAN_MONTHS[plan];
    const gross = batch.monthlyFeePaise * months;
    const bps = discountBpsFor(plan, batch);
    const amount = gross - Math.floor((gross * bps) / 10000);
    return {
      package_type: plan,
      months,
      amount_paise: amount,
      per_month_paise: Math.floor(amount / months),
      discount_pct: bps / 100,
    };
  });
}

export async function getEnrollmentRenewalOptions(batchId: string, userId: string, learnerId?: string) {
  const learner = await resolveLearner(userId, learnerId);
  const enrollment = await (prisma as any).enrollment.findUnique({
    where: { learnerId_batchId: { learnerId: learner.id, batchId } },
    include: { batch: true },
  });
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  return { options: getRenewalOptions(enrollment.batch) };
}

export async function createEnrollmentWithPeriod(
  batchId: string,
  userId: string,
  packageType: PackageType,
  learnerId?: string,
) {
  // The account enrolls and pays; the learner attends. One enrollment per learner per batch.
  const learner = await resolveLearner(userId, learnerId);
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.status !== 'active') throw new AppError('VALIDATION', 400, 'Batch not accepting enrollments');
  await assertLearnerFitsBatch(learner, batch);

  const amountPaise = computeAmount(batch.monthlyFeePaise, packageType, batch);
  const startDate = toDateOnly(new Date());
  const endDate = toDateOnly(addMonths(startDate, PLAN_MONTHS[packageType]));
  const gracePeriodEnd = addDays(endDate, 7);

  const enrollment = await prisma.enrollment.upsert({
    where: { learnerId_batchId: { learnerId: learner.id, batchId } },
    create: { id: newId(), userId, learnerId: learner.id, batchId, status: 'inactive' },
    update: {},
  });

  const periodId = newId();
  const idempotencyKey = crypto.createHash('sha256').update(`enr:${enrollment.id}:${packageType}:${startDate.toISOString()}`).digest('hex');

  const existingPayment = await repo.findEnrollmentPaymentByIdempotencyKey(idempotencyKey);
  if (existingPayment) {
    return { enrollment_id: enrollment.id, enrollment_period_id: existingPayment.enrollmentPeriodId, requires_payment: true, razorpay_order_id: existingPayment.razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: existingPayment.amountPaise, currency: 'INR' };
  }

  await repo.createEnrollmentPeriod({ id: periodId, enrollmentId: enrollment.id, packageType, startDate, endDate, amountPaise, gracePeriodEnd });
  const razorpayOrderId = await createRazorpayOrder(periodId, amountPaise, enrollment.id);
  await repo.createEnrollmentPayment({ id: newId(), enrollmentPeriodId: periodId, amountPaise, currency: 'INR', razorpayOrderId, idempotencyKey });

  return { enrollment_id: enrollment.id, enrollment_period_id: periodId, requires_payment: true, razorpay_order_id: razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: amountPaise, currency: 'INR' };
}

export async function renewEnrollment(batchId: string, userId: string, packageType: PackageType, learnerId?: string) {
  const learner = await resolveLearner(userId, learnerId);
  const enrollment = await (prisma as any).enrollment.findUnique({
    where: { learnerId_batchId: { learnerId: learner.id, batchId } },
    include: { batch: true },
  });
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  if (enrollment.batch.status !== 'active') throw new AppError('VALIDATION', 400, 'Batch is not active');

  const latest = await repo.findLatestPeriod(enrollment.id);
  const today = toDateOnly(new Date());
  const startDate = latest && latest.endDate > today ? toDateOnly(addDays(latest.endDate, 1)) : today;
  const endDate = toDateOnly(addMonths(startDate, PLAN_MONTHS[packageType]));
  const gracePeriodEnd = addDays(endDate, 7);
  const amountPaise = computeAmount(enrollment.batch.monthlyFeePaise, packageType, enrollment.batch);

  const periodId = newId();
  const idempotencyKey = crypto.createHash('sha256').update(`renew:${enrollment.id}:${packageType}:${startDate.toISOString()}`).digest('hex');

  const existingPayment = await repo.findEnrollmentPaymentByIdempotencyKey(idempotencyKey);
  if (existingPayment) {
    return { enrollment_id: enrollment.id, enrollment_period_id: existingPayment.enrollmentPeriodId, requires_payment: true, razorpay_order_id: existingPayment.razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: existingPayment.amountPaise, currency: 'INR' };
  }

  await repo.createEnrollmentPeriod({ id: periodId, enrollmentId: enrollment.id, packageType, startDate, endDate, amountPaise, gracePeriodEnd });
  const razorpayOrderId = await createRazorpayOrder(periodId, amountPaise, enrollment.id);
  await repo.createEnrollmentPayment({ id: newId(), enrollmentPeriodId: periodId, amountPaise, currency: 'INR', razorpayOrderId, idempotencyKey });

  return { enrollment_id: enrollment.id, enrollment_period_id: periodId, requires_payment: true, razorpay_order_id: razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: amountPaise, currency: 'INR' };
}

export async function getEnrollment(enrollmentId: string, userId: string) {
  const enrollment = await repo.findEnrollmentByIdAndUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  const period = enrollment.periods[0] ?? null;
  const pause = enrollment.pauses[0] ?? null;
  // The app needs the REMAINING weeks to render selectable pause lengths; deriving it client-side
  // would duplicate the allowance rule in two places.
  const allowance = period ? await pauseAllowanceForPeriod(period) : null;
  return {
    enrollment: {
      id: enrollment.id,
      learner_id: enrollment.learnerId,
      learner: enrollment.learner ? { id: enrollment.learner.id, name: enrollment.learner.name } : null,
      batch_id: enrollment.batchId,
      batch_title: enrollment.batch.title,
      // Batch discontinuation lifecycle — student app disables renew when 'closing'/'ended'.
      batch_status: enrollment.batch.status,
      status: enrollment.status,
      paused_until: enrollment.pausedUntil?.toISOString() ?? null,
      default_package: enrollment.defaultPackage ?? null,
      discontinue_requested_at: enrollment.discontinueRequestedAt?.toISOString() ?? null,
      started_at: enrollment.startedAt.toISOString(),
      current_period: period ? {
        id: period.id,
        package_type: period.packageType,
        start_date: period.startDate.toISOString().split('T')[0],
        end_date: period.endDate.toISOString().split('T')[0],
        amount_paise: period.amountPaise,
        status: period.status,
        grace_period_end: period.gracePeriodEnd?.toISOString().split('T')[0] ?? null,
        discontinue_effective_at: period.discontinueEffectiveAt?.toISOString().split('T')[0] ?? null,
        discontinue_reason: period.discontinueReason ?? null,
      } : null,
      active_pause: pause ? {
        id: pause.id,
        duration: pause.duration,
        status: pause.status,
        start_date: pause.startDate?.toISOString().split('T')[0] ?? null,
        end_date: pause.endDate?.toISOString().split('T')[0] ?? null,
        reason: pause.reason ?? null,
      } : null,
      // Pause allowance for the CURRENT paid period (refreshes on renewal).
      pause_allowance: allowance ? {
        allowance_weeks: allowance.allowanceWeeks,
        used_weeks: allowance.usedWeeks,
        remaining_weeks: allowance.remainingWeeks,
      } : null,
    },
  };
}

export async function discontinueEnrollment(enrollmentId: string, userId: string, body: { immediate: boolean; reason: string }) {
  const enrollment = await repo.findEnrollmentByIdAndUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  if (enrollment.status !== 'active') throw new AppError('VALIDATION', 400, 'Enrollment is not active');

  const period = await repo.findActivePeriod(enrollmentId);
  if (!period) throw new AppError('VALIDATION', 400, 'No active enrollment period found');
  if (period.discontinueRequestedAt) throw new AppError('VALIDATION', 400, 'Discontinuation already requested');

  if (period.payment?.status === 'pending') {
    throw new AppError('VALIDATION', 400, 'Payment is pending. Please wait for confirmation before discontinuing.');
  }

  const today = toDateOnly(new Date());
  const endDate = new Date(period.endDate);
  const remainingMs = endDate.getTime() - today.getTime();
  const remainingDays = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const totalDays = Math.floor((endDate.getTime() - new Date(period.startDate).getTime()) / (24 * 60 * 60 * 1000));

  const academy = enrollment.batch.academy;
  const refundPolicy = academy.monthlyRefundPolicy ?? 'no_refund';

  let immediate = body.immediate;
  let refundInitiated = false;
  let refundAmountPaise = 0;

  if (refundPolicy === 'no_refund' || remainingDays <= 14) {
    immediate = false;
  }

  if (immediate && refundPolicy !== 'no_refund' && period.payment?.status === 'captured') {
    if (refundPolicy === 'prorated' && remainingDays > 0 && totalDays > 0) {
      refundAmountPaise = Math.floor(period.amountPaise * remainingDays / totalDays);
    } else if (refundPolicy === 'full_if_early') {
      const daysElapsed = totalDays - remainingDays;
      refundAmountPaise = daysElapsed <= 7 ? period.amountPaise : 0;
    }

    if (refundAmountPaise >= 5000 && period.payment.razorpayPaymentId) {
      try {
        const { issueRazorpayRefund } = await import('../payments/service.js');
        const { updateEnrollmentPaymentRefunded } = await import('../payments/repo.js');
        const refundId = await issueRazorpayRefund(period.payment.razorpayPaymentId, refundAmountPaise);
        await updateEnrollmentPaymentRefunded(period.payment.id, refundId, refundAmountPaise);
        // S2.4: reverse the enrolment commission proportionally to the refund.
        const { reverseCommission } = await import('../payments/repo.js');
        await reverseCommission('enrollment', period.id, refundAmountPaise);
        refundInitiated = true;
      } catch { /* reconcile worker will retry */ }
    } else {
      immediate = false;
    }
  }

  if (immediate) {
    await prisma.$transaction(async (tx: any) => {
      await repo.setEnrollmentPeriodCancelled(period.id, tx);
      await repo.setEnrollmentInactive(enrollmentId, tx);
      await (tx as any).enrollmentPeriod.update({
        where: { id: period.id },
        data: { discontinueRequestedAt: new Date(), discontinueEffectiveAt: new Date(), discontinueReason: body.reason },
      });
    });
    try {
      await sendPushNotifications({
        subjectId: userId,
        subjectRole: 'student',
        title: 'Batch discontinued',
        body: refundInitiated
          ? `${whose(enrollment.learner)} ${enrollment.batch.title} enrollment has ended. Refund of ₹${Math.floor(refundAmountPaise / 100)} initiated.`
          : `${whose(enrollment.learner)} ${enrollment.batch.title} enrollment has ended.`,
        data: { screen: 'enrollments' },
      });
    } catch { /* non-fatal */ }
  } else {
    await repo.cancelEnrollmentPeriod(period.id, body.reason, false);
    await (prisma as any).enrollmentPeriod.update({
      where: { id: period.id },
      data: { discontinueEffectiveAt: period.endDate },
    });
    await (prisma as any).enrollment.update({
      where: { id: enrollmentId },
      data: { discontinueRequestedAt: new Date() },
    });
    try {
      await sendPushNotifications({
        subjectId: userId,
        subjectRole: 'student',
        title: 'Discontinuation scheduled',
        body: `${whose(enrollment.learner)} ${enrollment.batch.title} access will end on ${endDate.toISOString().split('T')[0]}.`,
        data: { screen: 'enrollments' },
      });
    } catch { /* non-fatal */ }
  }

  return {
    effective_at: immediate ? new Date().toISOString() : endDate.toISOString().split('T')[0],
    refund_initiated: refundInitiated,
    refund_amount_paise: refundAmountPaise,
  };
}

export async function cancelDiscontinuation(enrollmentId: string, userId: string) {
  const enrollment = await repo.findEnrollmentByIdAndUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');

  const period = await repo.findActivePeriod(enrollmentId);
  if (!period) throw new AppError('VALIDATION', 400, 'No active period found');
  if (!period.discontinueRequestedAt) throw new AppError('VALIDATION', 400, 'No pending discontinuation to cancel');
  if (period.status === 'cancelled') throw new AppError('VALIDATION', 400, 'Enrollment already discontinued');

  await repo.clearDiscontinuation(period.id, enrollmentId);

  return { cancelled: true };
}

/**
 * Pause weeks available on a paid period. The allowance is per PERIOD (monthly 1, quarterly 2) and
 * refreshes on renewal; quarterly's 2 weeks may be split into two 1-week pauses, so callers must
 * gate on weeks REMAINING rather than on whether a pause already exists.
 *
 * A pause resumed early still consumes its full granted length — the unused remainder is forfeited
 * (owner decision 2026-09-05), which is why this sums granted durations and never elapsed days.
 */
export async function pauseAllowanceForPeriod(period: { id: string; packageType: string }) {
  const allowanceWeeks = pauseAllowanceWeeks(period.packageType);
  const pauses = await repo.findPausesForPeriod(period.id);
  const usedWeeks = pauses.reduce(
    (sum: number, p: { duration: string }) => sum + (pauseWeeksForDuration(p.duration) ?? 0),
    0,
  );
  return {
    allowanceWeeks,
    usedWeeks,
    // Legacy pauses predate the period grain and are attributed best-effort by the migration, so
    // clamp: a mis-attributed row must never render a negative allowance in the app.
    remainingWeeks: Math.max(0, allowanceWeeks - usedWeeks),
  };
}

export async function requestPause(enrollmentId: string, userId: string, body: { duration: string; reason?: string }) {
  const enrollment = await repo.findEnrollmentByIdAndUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  if (enrollment.status !== 'active') throw new AppError('VALIDATION', 400, 'Enrollment is not active');
  if (enrollment.pausedUntil && new Date() < enrollment.pausedUntil) {
    throw new AppError('VALIDATION', 400, 'Enrollment is already paused');
  }

  const activePause = enrollment.pauses[0];
  if (activePause) throw new AppError('VALIDATION', 400, 'A pause request is already pending or active');

  const period = await repo.findActivePeriod(enrollmentId);
  if (!period || period.status === 'grace') throw new AppError('VALIDATION', 400, 'Cannot pause during grace period — please renew first');

  const pauseRequiresApproval = enrollment.batch.academy.pauseRequiresApproval ?? true;
  const durationDays = pauseDurationDays(body.duration);
  const requestedWeeks = pauseWeeksForDuration(body.duration);
  if (durationDays === null || requestedWeeks === null) {
    throw new AppError('VALIDATION', 400, 'Invalid pause duration');
  }

  // The cap is per paid period, so a monthly student gets 1 week each month they renew and a
  // quarterly student 2 per quarter — taken in one block or as two separate weeks.
  const { allowanceWeeks, remainingWeeks } = await pauseAllowanceForPeriod(period);
  if (requestedWeeks > remainingWeeks) {
    const plural = (n: number) => `${n} week${n === 1 ? '' : 's'}`;
    throw new AppError(
      'PAUSE_ALLOWANCE_EXCEEDED',
      400,
      remainingWeeks <= 0
        ? `A ${period.packageType} enrolment includes ${plural(allowanceWeeks)} of pause, and you've used it all in this period. Your allowance refreshes when you renew.`
        : `Only ${plural(remainingWeeks)} of pause is left in this period.`,
      { duration: body.duration },
    );
  }

  if (pauseRequiresApproval) {
    const pause = await repo.createPause({
      id: newId(),
      enrollmentId,
      enrollmentPeriodId: period.id,
      duration: body.duration,
      reason: body.reason,
      status: 'pending',
    });
    return { pause_id: pause.id, status: 'pending', message: 'Pause request sent to academy for approval.' };
  } else {
    const startDate = toDateOnly(new Date());
    const endDate = addDays(startDate, durationDays);
    const pause = await repo.createPause({
      id: newId(),
      enrollmentId,
      enrollmentPeriodId: period.id,
      duration: body.duration,
      reason: body.reason,
      status: 'active',
      startDate,
      endDate,
    });
    await repo.updateEnrollmentPausedUntil(enrollmentId, endDate);
    return { pause_id: pause.id, status: 'active', paused_until: endDate.toISOString().split('T')[0] };
  }
}

export async function resumePause(enrollmentId: string, pauseId: string, userId: string) {
  const enrollment = await repo.findEnrollmentByIdAndUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');

  const pause = await repo.findPauseById(pauseId);
  if (!pause || pause.enrollmentId !== enrollmentId) throw new AppError('NOT_FOUND', 404, 'Pause not found');
  if (pause.status !== 'active') throw new AppError('VALIDATION', 400, 'Pause is not currently active');

  const period = await repo.findActivePeriod(enrollmentId);
  if (!period) throw new AppError('NOT_FOUND', 404, 'No active period found');

  const resumedAt = new Date();
  const actualExtensionDays = Math.floor((resumedAt.getTime() - pause.startDate.getTime()) / (24 * 60 * 60 * 1000));
  const newEndDate = addDays(new Date(period.endDate), actualExtensionDays);
  const newGracePeriodEnd = addDays(newEndDate, 7);

  let coveredSessions = 0;
  await prisma.$transaction(async (tx: any) => {
    await repo.updatePauseResumed(pauseId, tx);
    await repo.extendPeriodEndDate(period.id, newEndDate, newGracePeriodEnd, tx);
    await repo.updateEnrollmentPausedUntil(enrollmentId, null, tx);
    // Credit only the classes that fell inside the SHORTENED window — resuming early means fewer
    // classes were missed, and the period extension above is likewise the elapsed days, not the
    // full granted length. The unused allowance is still forfeited (it stays consumed).
    coveredSessions = await creditPauseCoverage(tx, {
      enrollmentId,
      batchId: enrollment.batchId,
      from: pause.startDate,
      to: resumedAt,
    });
  });

  return {
    resumed: true,
    new_end_date: newEndDate.toISOString().split('T')[0],
    covered_sessions: coveredSessions,
  };
}

export async function requestTransfer(enrollmentId: string, userId: string, body: { target_batch_id: string; reason?: string }) {
  const enrollment = await repo.findEnrollmentByIdAndUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  if (enrollment.status !== 'active') throw new AppError('VALIDATION', 400, 'Enrollment is not active');
  if (enrollment.pausedUntil && new Date() < enrollment.pausedUntil) {
    throw new AppError('VALIDATION', 400, 'Cannot transfer while enrollment is paused');
  }
  if (enrollment.discontinueRequestedAt) {
    throw new AppError('VALIDATION', 400, 'Cannot transfer while discontinuation is pending');
  }

  const targetBatch = await prisma.batch.findUnique({ where: { id: body.target_batch_id } });
  if (!targetBatch) throw new AppError('NOT_FOUND', 404, 'Target batch not found');
  if (targetBatch.status !== 'active') throw new AppError('VALIDATION', 400, 'Target batch is not active');
  // Same-BRANCH only. `Academy` is the branch, so this check already read as "same branch"
  // the day the group landed — only the copy needed to change, so a multi-branch owner is not
  // told their two locations are different academies.
  //
  // Cross-branch transfer stays blocked deliberately: `approveTransfer` cancels the old period
  // and recreates the remainder at amountPaise 0, which across branches on DIFFERENT financial
  // entities would silently move already-captured revenue's obligation from one payee to
  // another. Doing it properly needs an inter-entity value transfer netted through the existing
  // AcademyRecovery machinery — separate financial work (plan §8/§10).
  if (targetBatch.academyId !== enrollment.batch.academyId) {
    throw new AppError('VALIDATION', 400, 'Can only transfer within the same branch');
  }
  if (body.target_batch_id === enrollment.batchId) {
    throw new AppError('VALIDATION', 400, 'Already enrolled in this batch');
  }

  const activeCount = await repo.countActiveEnrollments(body.target_batch_id);
  if (activeCount >= targetBatch.capacity) throw new AppError('VALIDATION', 400, 'Target batch is full');

  const request = await repo.createTransferRequest({ id: newId(), fromEnrollmentId: enrollmentId, toBatchId: body.target_batch_id, reason: body.reason });

  if (!enrollment.batch.academy.transferRequiresApproval) {
    await approveTransfer(request.id, enrollment.batch.academyId);
    return { transfer_id: request.id, status: 'approved' };
  }

  return { transfer_id: request.id, status: 'pending', message: 'Transfer request sent to academy for approval.' };
}

export async function approveTransfer(requestId: string, academyId: string) {
  const request = await repo.findTransferRequestById(requestId);
  if (!request) throw new AppError('NOT_FOUND', 404, 'Transfer request not found');
  if (request.toBatch.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your branch');
  if (request.status !== 'pending') throw new AppError('VALIDATION', 400, 'Request already processed');

  const activeCount = await repo.countActiveEnrollments(request.toBatchId);
  if (activeCount >= request.toBatch.capacity) throw new AppError('VALIDATION', 400, 'Target batch is now full');

  const period = await repo.findActivePeriod(request.fromEnrollmentId);
  const today = toDateOnly(new Date());
  const remainingDays = period ? Math.max(0, Math.floor((new Date(period.endDate).getTime() - today.getTime()) / (24 * 60 * 60 * 1000))) : 0;

  await prisma.$transaction(async (tx: any) => {
    await (tx as any).enrollment.update({ where: { id: request.fromEnrollmentId }, data: { status: 'inactive' } });
    if (period) await repo.setEnrollmentPeriodCancelled(period.id, tx);

    const newEnrollmentId = newId();
    await (tx as any).enrollment.create({
      data: {
        id: newEnrollmentId,
        userId: request.fromEnrollment.userId,
        learnerId: request.fromEnrollment.learnerId,
        batchId: request.toBatchId,
        status: 'active',
      },
    });

    if (remainingDays > 0 && period) {
      const newPeriodId = newId();
      const newEndDate = addDays(today, remainingDays);
      const newGracePeriodEnd = addDays(newEndDate, 7);
      await (tx as any).enrollmentPeriod.create({
        data: {
          id: newPeriodId,
          enrollmentId: newEnrollmentId,
          packageType: period.packageType,
          startDate: today,
          endDate: newEndDate,
          amountPaise: 0,
          status: 'active',
          gracePeriodEnd: newGracePeriodEnd,
        },
      });
      await (tx as any).enrollment.update({ where: { id: newEnrollmentId }, data: { currentPeriodId: newPeriodId } });
    }

    await repo.updateTransferApproved(requestId, newEnrollmentId, tx);
  });

  try {
    await sendPushNotifications({
      subjectId: request.fromEnrollment.userId,
      subjectRole: 'student',
      title: 'Transfer approved',
      body: request.fromEnrollment.learner && !request.fromEnrollment.learner.selfOf
        ? `${request.fromEnrollment.learner.name} has been moved to ${request.toBatch.title}.`
        : `You've been transferred to ${request.toBatch.title}.`,
      data: { screen: 'enrollments' },
    });
  } catch { /* non-fatal */ }

  return { approved: true };
}

export async function rejectTransfer(requestId: string, academyId: string, reason: string) {
  const request = await repo.findTransferRequestById(requestId);
  if (!request) throw new AppError('NOT_FOUND', 404, 'Transfer request not found');
  if (request.toBatch.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your branch');
  if (request.status !== 'pending') throw new AppError('VALIDATION', 400, 'Request already processed');

  await repo.updateTransferRejected(requestId, reason);

  try {
    await sendPushNotifications({
      subjectId: request.fromEnrollment.userId,
      subjectRole: 'student',
      title: 'Transfer request rejected',
      body: reason || `The transfer request for ${whose(request.fromEnrollment.learner, { lower: true })} class to ${request.toBatch.title} was declined.`,
      data: { screen: 'enrollments' },
    });
  } catch { /* non-fatal */ }

  return { rejected: true };
}

export async function approvePause(enrollmentId: string, pauseId: string, academyId: string) {
  const pause = await repo.findPauseById(pauseId);
  if (!pause || pause.enrollmentId !== enrollmentId) throw new AppError('NOT_FOUND', 404, 'Pause not found');
  if (pause.status !== 'pending') throw new AppError('VALIDATION', 400, 'Pause already processed');

  const enrollment = await repo.findEnrollmentById(enrollmentId);
  if (!enrollment || enrollment.batch.academy.id !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your academy');

  const durationDays = pauseDurationDays(pause.duration) ?? 7;
  const startDate = toDateOnly(new Date());
  const endDate = addDays(startDate, durationDays);

  await prisma.$transaction(async (tx: any) => {
    await repo.updatePauseApproved(pauseId, startDate, endDate, tx);
    await repo.updateEnrollmentPausedUntil(enrollmentId, endDate, tx);
  });

  try {
    await sendPushNotifications({
      subjectId: enrollment.userId,
      subjectRole: 'student',
      title: 'Pause approved',
      body: `${whose(enrollment.learner)} enrollment in ${enrollment.batch.title} is paused until ${endDate.toISOString().split('T')[0]}.`,
      data: { screen: 'enrollments' },
    });
  } catch { /* non-fatal */ }

  return { approved: true, paused_until: endDate.toISOString().split('T')[0] };
}

export async function rejectPause(enrollmentId: string, pauseId: string, academyId: string, reason: string) {
  const pause = await repo.findPauseById(pauseId);
  if (!pause || pause.enrollmentId !== enrollmentId) throw new AppError('NOT_FOUND', 404, 'Pause not found');
  if (pause.status !== 'pending') throw new AppError('VALIDATION', 400, 'Pause already processed');

  const enrollment = await repo.findEnrollmentById(enrollmentId);
  if (!enrollment || enrollment.batch.academy.id !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your academy');

  await repo.updatePauseRejected(pauseId, reason);

  try {
    await sendPushNotifications({
      subjectId: enrollment.userId,
      subjectRole: 'student',
      title: 'Pause request declined',
      body: reason || `The pause request for ${whose(enrollment.learner, { lower: true })} ${enrollment.batch.title} class was declined.`,
      data: { screen: 'enrollments' },
    });
  } catch { /* non-fatal */ }

  return { rejected: true };
}

export async function setPreferredPackage(enrollmentId: string, userId: string, packageType: string) {
  if (!(packageType in PLAN_MONTHS)) throw new AppError('VALIDATION', 400, 'Invalid package type');
  const enrollment = await repo.findEnrollmentByIdAndUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  await repo.setPreferredPackage(enrollmentId, packageType);
  return { default_package: packageType };
}

export async function getEnrollmentsForBatch(batchId: string, scope: BatchScope) {
  // Scoped, not just branch-compared: this returns the batch's full roster, so a teacher must
  // not be able to read another coach's batch by passing its id.
  const batch = await prisma.batch.findFirst({ where: batchScopeById(scope, batchId) });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  const enrollments = await repo.findEnrollmentsForBatch(batchId);
  return {
    items: enrollments.map((e: any) => ({
      id: e.id,
      user_id: e.userId,
      // The student shown is the learner; for a child that is not the account holder.
      user_name: e.learner?.name || e.user.name,
      learner_id: e.learnerId,
      learner_name: e.learner?.name || e.user.name,
      guardian: { name: e.user.name, phone: e.user.phone },
      status: e.status,
      started_at: e.startedAt.toISOString(),
      paused_until: e.pausedUntil?.toISOString() ?? null,
      current_period: e.periods[0] ? {
        package_type: e.periods[0].packageType,
        end_date: e.periods[0].endDate.toISOString().split('T')[0],
        status: e.periods[0].status,
      } : null,
    })),
  };
}

export async function getPendingPausesForAcademy(academyId: string) {
  const pauses = await repo.findPendingPausesForAcademy(academyId);
  return {
    items: pauses.map((p: any) => ({
      id: p.id,
      enrollment_id: p.enrollmentId,
      student_name: p.enrollment.user.name,
      batch_title: p.enrollment.batch.title,
      duration: p.duration,
      reason: p.reason ?? null,
      requested_at: p.requestedAt.toISOString(),
    })),
  };
}

// §5.3: group-scoped by design (a transfer can cross branches, so it must be visible to
// whoever owns the destination). `allowedIds` narrows it for a branch-scoped subject.
export async function getPendingTransfersForGroup(groupId: string, allowedIds?: string[]) {
  const requests = await repo.findPendingTransfersForGroup(groupId, allowedIds);
  return {
    items: requests.map((r: any) => ({
      id: r.id,
      from_enrollment_id: r.fromEnrollmentId,
      student_name: r.fromEnrollment.user.name,
      from_batch: r.fromEnrollment.batch.title,
      to_batch: r.toBatch.title,
      reason: r.reason ?? null,
      requested_at: r.requestedAt.toISOString(),
      branch_id: r.toBatch.academy.id,
      branch_label: r.toBatch.academy.branchLabel ?? r.toBatch.academy.name,
    })),
  };
}
