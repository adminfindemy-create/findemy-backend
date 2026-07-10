import crypto from 'node:crypto';
import { PLAN_MONTHS, DISCOUNT_BPS_CAP, type Plan } from '@findemy/types';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import * as repo from './repo.js';
import { sendPushNotifications } from '../push/service.js';

// S2.3: months come from the shared contract; the discount % comes from the BATCH's
// academy-set quarterly/annual bps (S1.3), capped at 30%. `biannual` is dropped.
type PackageType = Plan;
type BatchDiscount = { quarterlyDiscountBps: number; annualDiscountBps: number };

function discountBpsFor(plan: Plan, batch: BatchDiscount): number {
  const bps = plan === 'quarterly' ? batch.quarterlyDiscountBps : plan === 'annual' ? batch.annualDiscountBps : 0;
  return Math.min(bps, DISCOUNT_BPS_CAP);
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
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
    const razorpayClient = await getRazorpay();
    const order = await razorpayClient.orders.create({
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

export async function getEnrollmentRenewalOptions(batchId: string, userId: string) {
  const enrollment = await (prisma as any).enrollment.findUnique({
    where: { userId_batchId: { userId, batchId } },
    include: { batch: true },
  });
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  return { options: getRenewalOptions(enrollment.batch) };
}

export async function createEnrollmentWithPeriod(batchId: string, userId: string, packageType: PackageType) {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.status !== 'active') throw new AppError('VALIDATION', 400, 'Batch not accepting enrollments');

  const amountPaise = computeAmount(batch.monthlyFeePaise, packageType, batch);
  const startDate = toDateOnly(new Date());
  const endDate = toDateOnly(addMonths(startDate, PLAN_MONTHS[packageType]));
  const gracePeriodEnd = addDays(endDate, 7);

  const enrollment = await prisma.enrollment.upsert({
    where: { userId_batchId: { userId, batchId } },
    create: { id: newId(), userId, batchId, status: 'inactive' },
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

export async function renewEnrollment(batchId: string, userId: string, packageType: PackageType) {
  const enrollment = await (prisma as any).enrollment.findUnique({
    where: { userId_batchId: { userId, batchId } },
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
  return {
    enrollment: {
      id: enrollment.id,
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
          ? `You've been unenrolled from ${enrollment.batch.title}. Refund of ₹${Math.floor(refundAmountPaise / 100)} initiated.`
          : `You've been unenrolled from ${enrollment.batch.title}.`,
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
        body: `Your ${enrollment.batch.title} access will end on ${endDate.toISOString().split('T')[0]}.`,
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
  const durationDays = { one_week: 7, two_weeks: 14, one_month: 30 }[body.duration as string];
  if (!durationDays) throw new AppError('VALIDATION', 400, 'Invalid pause duration');

  if (pauseRequiresApproval) {
    const pause = await repo.createPause({
      id: newId(),
      enrollmentId,
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

  await prisma.$transaction(async (tx: any) => {
    await repo.updatePauseResumed(pauseId, tx);
    await repo.extendPeriodEndDate(period.id, newEndDate, newGracePeriodEnd, tx);
    await repo.updateEnrollmentPausedUntil(enrollmentId, null, tx);
  });

  return { resumed: true, new_end_date: newEndDate.toISOString().split('T')[0] };
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
  if (targetBatch.academyId !== enrollment.batch.academyId) {
    throw new AppError('VALIDATION', 400, 'Can only transfer within the same academy');
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
  if (request.toBatch.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your academy');
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
      data: { id: newEnrollmentId, userId: request.fromEnrollment.userId, batchId: request.toBatchId, status: 'active' },
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
      body: `You've been transferred to ${request.toBatch.title}.`,
      data: { screen: 'enrollments' },
    });
  } catch { /* non-fatal */ }

  return { approved: true };
}

export async function rejectTransfer(requestId: string, academyId: string, reason: string) {
  const request = await repo.findTransferRequestById(requestId);
  if (!request) throw new AppError('NOT_FOUND', 404, 'Transfer request not found');
  if (request.toBatch.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your academy');
  if (request.status !== 'pending') throw new AppError('VALIDATION', 400, 'Request already processed');

  await repo.updateTransferRejected(requestId, reason);

  try {
    await sendPushNotifications({
      subjectId: request.fromEnrollment.userId,
      subjectRole: 'student',
      title: 'Transfer request rejected',
      body: reason || `Your transfer request to ${request.toBatch.title} was declined.`,
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

  const durationDays = { one_week: 7, two_weeks: 14, one_month: 30 }[pause.duration as string] ?? 7;
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
      body: `Your enrollment in ${enrollment.batch.title} is paused until ${endDate.toISOString().split('T')[0]}.`,
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
      body: reason || `Your pause request for ${enrollment.batch.title} was declined.`,
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

export async function getEnrollmentsForBatch(batchId: string, academyId: string) {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your batch');

  const enrollments = await repo.findEnrollmentsForBatch(batchId);
  return {
    items: enrollments.map((enrollment: any) => ({
      id: enrollment.id,
      user_id: enrollment.userId,
      user_name: enrollment.user.name,
      status: enrollment.status,
      started_at: enrollment.startedAt.toISOString(),
      paused_until: enrollment.pausedUntil?.toISOString() ?? null,
      current_period: enrollment.periods[0] ? {
        package_type: enrollment.periods[0].packageType,
        end_date: enrollment.periods[0].endDate.toISOString().split('T')[0],
        status: enrollment.periods[0].status,
      } : null,
    })),
  };
}

export async function getPendingPausesForAcademy(academyId: string) {
  const pauses = await repo.findPendingPausesForAcademy(academyId);
  return {
    items: pauses.map((pause: any) => ({
      id: pause.id,
      enrollment_id: pause.enrollmentId,
      student_name: pause.enrollment.user.name,
      batch_title: pause.enrollment.batch.title,
      duration: pause.duration,
      reason: pause.reason ?? null,
      requested_at: pause.requestedAt.toISOString(),
    })),
  };
}

export async function getPendingTransfersForAcademy(academyId: string) {
  const requests = await repo.findPendingTransfersForAcademy(academyId);
  return {
    items: requests.map((request: any) => ({
      id: request.id,
      from_enrollment_id: request.fromEnrollmentId,
      student_name: request.fromEnrollment.user.name,
      from_batch: request.fromEnrollment.batch.title,
      to_batch: request.toBatch.title,
      reason: request.reason ?? null,
      requested_at: request.requestedAt.toISOString(),
    })),
  };
}
