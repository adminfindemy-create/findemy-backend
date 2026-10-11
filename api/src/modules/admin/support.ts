import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { ADMIN_REFUND_CAP_PAISE, TRIAL_REFUND_MIN_HOURS, WORKSHOP_REFUND_MIN_HOURS } from '../../config.js';
import { issueRazorpayRefund } from '../payments/service.js';
import {
  updatePaymentRefunded,
  updateWorkshopPaymentRefunded,
  updateEventPaymentRefunded,
  updateEnrollmentPaymentRefunded,
  reverseCommission,
} from '../payments/repo.js';
import { sendPushNotifications } from '../push/service.js';
import { requestOtp } from '../auth/service.js';
import { writeAudit } from './audit.js';

export type PaymentType = 'trial' | 'workshop' | 'event' | 'enrollment';

type LoadedPayment = {
  type: PaymentType;
  id: string;
  razorpayPaymentId: string | null;
  amountPaise: number;
  status: string;
  refundStatus: string | null;
  refundAmountPaise: number;
  // For proportional commission reversal (itemType/itemId keys into CommissionLedger).
  commissionItemType: PaymentType;
  commissionItemId: string;
  academyId: string | null;
  label: string;
  // Trial only: the scheduled trial time, used to evaluate the 4-hour refund window.
  trialAt?: Date | null;
  // Workshop only: the workshop start time, used to evaluate the 24-hour refund window.
  workshopStartAt?: Date | null;
};

// Load + normalize a payment from whichever of the 4 tables owns it, resolving the commission key
// and academy linkage. This is the single place that knows the per-type shape.
async function loadPayment(type: PaymentType, id: string): Promise<LoadedPayment | null> {
  if (type === 'trial') {
    const p = await prisma.payment.findUnique({
      where: { id },
      include: { booking: { include: { batch: true } } },
    });
    if (!p) return null;
    return {
      type, id: p.id, razorpayPaymentId: p.razorpayPaymentId, amountPaise: p.amountPaise,
      status: p.status, refundStatus: p.refundStatus, refundAmountPaise: p.refundAmountPaise ?? 0,
      commissionItemType: 'trial', commissionItemId: p.bookingId,
      academyId: p.booking.batch.academyId, label: `Trial · ${p.booking.batch.title}`,
      trialAt: p.booking.trialAt,
    };
  }
  if (type === 'workshop') {
    const p = await prisma.workshopPayment.findUnique({
      where: { id },
      include: { registration: { include: { workshop: true } } },
    });
    if (!p) return null;
    return {
      type, id: p.id, razorpayPaymentId: p.razorpayPaymentId, amountPaise: p.amountPaise,
      status: p.status, refundStatus: p.refundStatus, refundAmountPaise: p.refundAmountPaise ?? 0,
      commissionItemType: 'workshop', commissionItemId: p.id,
      academyId: p.registration.workshop.academyId, label: `Workshop · ${p.registration.workshop.title}`,
      workshopStartAt: p.registration.workshop.startAt,
    };
  }
  if (type === 'event') {
    const p = await prisma.eventPayment.findUnique({
      where: { id },
      include: { registration: { include: { event: true } } },
    });
    if (!p) return null;
    return {
      type, id: p.id, razorpayPaymentId: p.razorpayPaymentId, amountPaise: p.amountPaise,
      status: p.status, refundStatus: p.refundStatus, refundAmountPaise: p.refundAmountPaise ?? 0,
      commissionItemType: 'event', commissionItemId: p.id,
      academyId: null, label: `Event · ${p.registration.event.title}`,
    };
  }
  // enrollment
  const p = await prisma.enrollmentPayment.findUnique({
    where: { id },
    include: { enrollmentPeriod: { include: { enrollment: { include: { batch: true } } } } },
  });
  if (!p) return null;
  return {
    type, id: p.id, razorpayPaymentId: p.razorpayPaymentId, amountPaise: p.amountPaise,
    status: p.status, refundStatus: p.refundStatus, refundAmountPaise: p.refundAmountPaise ?? 0,
    commissionItemType: 'enrollment', commissionItemId: p.enrollmentPeriodId,
    academyId: p.enrollmentPeriod.enrollment.batch.academyId,
    label: `Enrollment · ${p.enrollmentPeriod.enrollment.batch.title}`,
  };
}

async function markRefunded(type: PaymentType, id: string, refundId: string, amount: number) {
  if (type === 'trial') return updatePaymentRefunded(id, refundId, amount);
  if (type === 'workshop') return updateWorkshopPaymentRefunded(id, refundId, amount);
  if (type === 'event') return updateEventPaymentRefunded(id, refundId, amount);
  return updateEnrollmentPaymentRefunded(id, refundId, amount);
}

// Admin (Support 360) refund. Scoped to TRIAL and WORKSHOP payments, matching product policy:
//   • Trials: refundable if ≥ TRIAL_REFUND_MIN_HOURS (4h) before the trial starts.
//   • Workshops: refundable if ≥ WORKSHOP_REFUND_MIN_HOURS (24h) before the workshop starts.
//   • Enrollment refunds happen via discontinuation/enrollment flows (academy-borne, pro-rata).
//   • Event refunds happen via event cancellation / the Events surface (platform-borne).
// Those last two are deliberately NOT ad-hoc admin actions. For trials/workshops a within-window
// refund requires an explicit `force` override, recorded in the audit trail. Reuses the Razorpay
// refund primitive + per-type payment updater + proportional commission reversal.
const REFUND_MIN_HOURS: Partial<Record<PaymentType, number>> = {
  trial: TRIAL_REFUND_MIN_HOURS,
  workshop: WORKSHOP_REFUND_MIN_HOURS,
};

export async function refundPayment(
  actorId: string,
  input: { paymentType: PaymentType; paymentId: string; amountPaise?: number; force?: boolean },
) {
  const minHours = REFUND_MIN_HOURS[input.paymentType];
  if (minHours === undefined) {
    throw new AppError(
      'REFUND_NOT_ALLOWED',
      400,
      'Only trial and workshop payments are refundable here. Enrollment and event refunds go through their own flows.',
    );
  }

  const p = await loadPayment(input.paymentType, input.paymentId);
  if (!p) throw new AppError('NOT_FOUND', 404, 'Payment not found');
  if (p.status !== 'captured') {
    throw new AppError('BAD_REQUEST', 400, `Only captured payments can be refunded (status=${p.status})`);
  }
  if (!p.razorpayPaymentId) {
    throw new AppError('BAD_REQUEST', 400, 'Payment has no Razorpay payment id');
  }
  if (p.refundStatus === 'requested' || p.refundStatus === 'processed') {
    throw new AppError('CONFLICT', 409, 'Payment already refunded; use retry for a failed refund');
  }

  // Refund window: eligible only if ≥ minHours before the trial/workshop start. An admin may
  // override a within-window refund with `force`, which is flagged in the audit trail.
  const startTime = (input.paymentType === 'trial' ? p.trialAt : p.workshopStartAt) ?? new Date();
  const hoursUntilStart = (startTime.getTime() - Date.now()) / (1000 * 60 * 60);
  const withinWindow = hoursUntilStart < minHours;
  if (withinWindow && !input.force) {
    const noun = input.paymentType === 'trial' ? 'Trial' : 'Workshop';
    throw new AppError(
      'REFUND_WINDOW',
      422,
      `${noun} is within ${minHours}h of start (non-refundable by policy). Pass force to override.`,
    );
  }

  const amount = input.amountPaise ?? p.amountPaise;
  if (amount <= 0 || amount > p.amountPaise) {
    throw new AppError('BAD_REQUEST', 400, `Refund must be between 1 and ${p.amountPaise} paise`);
  }
  if (amount > ADMIN_REFUND_CAP_PAISE) {
    throw new AppError('BAD_REQUEST', 400, `Refund exceeds the ₹${ADMIN_REFUND_CAP_PAISE / 100} cap`);
  }

  const refundId = await issueRazorpayRefund(p.razorpayPaymentId, amount);
  await markRefunded(input.paymentType, p.id, refundId, amount);
  await reverseCommission(input.paymentType, p.commissionItemId, amount);

  await writeAudit({
    adminId: actorId,
    action: 'support.refund',
    targetType: 'Payment',
    targetId: `${input.paymentType}:${p.id}`,
    after: { amountPaise: amount, refundId, academyId: p.academyId, overrodeWindow: withinWindow },
  });

  return {
    refund: { paymentType: input.paymentType, paymentId: p.id, amountPaise: amount, razorpayRefundId: refundId, refundStatus: 'requested', overrodeWindow: withinWindow },
  };
}

// Retry a failed refund (re-issue the Razorpay refund). The refund-reconcile worker then settles it.
export async function retryRefund(actorId: string, input: { paymentType: PaymentType; paymentId: string }) {
  const p = await loadPayment(input.paymentType, input.paymentId);
  if (!p) throw new AppError('NOT_FOUND', 404, 'Payment not found');
  if (p.refundStatus !== 'failed') {
    throw new AppError('BAD_REQUEST', 400, `Only failed refunds can be retried (refundStatus=${p.refundStatus})`);
  }
  const amount = p.refundAmountPaise || p.amountPaise;
  const refundId = await issueRazorpayRefund(p.razorpayPaymentId!, amount);
  await markRefunded(p.type, p.id, refundId, amount);
  await writeAudit({
    adminId: actorId,
    action: 'support.refund_retry',
    targetType: 'Payment',
    targetId: `${p.type}:${p.id}`,
    after: { amountPaise: amount, refundId },
  });
  return { refund: { paymentType: p.type, paymentId: p.id, amountPaise: amount, razorpayRefundId: refundId, refundStatus: 'requested' } };
}

// Refunds console: every in-flight (`requested`) or `failed` refund across all 4 payment tables.
export async function listRefunds(status: 'requested' | 'failed') {
  const rows: Array<{
    paymentType: PaymentType; paymentId: string; amountPaise: number;
    refundAmountPaise: number; refundStatus: string | null; razorpayRefundId: string | null; createdAt: Date;
    userId: string | null; userName: string | null; userPhone: string | null;
  }> = [];

  // `getUser` extracts the payer (id/name/phone) from each table's relation chain so refunds are
  // traceable to a person in the console.
  const push = (type: PaymentType, list: any[], getUser: (r: any) => { id: string; name: string | null; phone: string | null } | null | undefined) => {
    for (const r of list) {
      const u = getUser(r);
      rows.push({
        paymentType: type, paymentId: r.id, amountPaise: r.amountPaise,
        refundAmountPaise: r.refundAmountPaise ?? 0, refundStatus: r.refundStatus,
        razorpayRefundId: r.razorpayRefundId, createdAt: r.createdAt,
        userId: u?.id ?? null, userName: u?.name ?? null, userPhone: u?.phone ?? null,
      });
    }
  };
  const where = { refundStatus: status };
  const u = { select: { id: true, name: true, phone: true } };
  push('trial', await prisma.payment.findMany({ where, include: { booking: { include: { user: u } } } }), (r) => r.booking?.user);
  push('workshop', await prisma.workshopPayment.findMany({ where, include: { registration: { include: { user: u } } } }), (r) => r.registration?.user);
  push('event', await prisma.eventPayment.findMany({ where, include: { registration: { include: { user: u } } } }), (r) => r.registration?.user);
  push('enrollment', await prisma.enrollmentPayment.findMany({ where, include: { enrollmentPeriod: { include: { enrollment: { include: { user: u } } } } } }), (r) => r.enrollmentPeriod?.enrollment?.user);
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { refunds: rows };
}

// ---------- Support 360 lookup ----------

// Unified payment list for one user across the 4 tables — the actionable rows a support agent
// refunds from.
async function userPayments(userId: string) {
  const [trial, workshop, event, enrollment] = await Promise.all([
    prisma.payment.findMany({
      where: { booking: { userId } },
      include: { booking: { include: { batch: true } } },
    }),
    prisma.workshopPayment.findMany({
      where: { registration: { userId } },
      include: { registration: { include: { workshop: true } } },
    }),
    prisma.eventPayment.findMany({
      where: { registration: { userId } },
      include: { registration: { include: { event: true } } },
    }),
    prisma.enrollmentPayment.findMany({
      where: { enrollmentPeriod: { enrollment: { userId } } },
      include: { enrollmentPeriod: { include: { enrollment: { include: { batch: true } } } } },
    }),
  ]);

  const norm = (type: PaymentType, r: any, label: string) => ({
    paymentType: type, paymentId: r.id, amountPaise: r.amountPaise, status: r.status,
    refundStatus: r.refundStatus, refundAmountPaise: r.refundAmountPaise ?? 0, createdAt: r.createdAt, label,
  });
  return [
    ...trial.map((r) => norm('trial', r, `Trial · ${r.booking.batch.title}`)),
    ...workshop.map((r) => norm('workshop', r, `Workshop · ${r.registration.workshop.title}`)),
    ...event.map((r) => norm('event', r, `Event · ${r.registration.event.title}`)),
    ...enrollment.map((r) => norm('enrollment', r, `Enrollment · ${r.enrollmentPeriod.enrollment.batch.title}`)),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function lookup(q: string) {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 5,
    select: { id: true, name: true, phone: true, email: true },
  });

  const usersWith360 = await Promise.all(
    users.map(async (u) => ({
      ...u,
      trials: await prisma.trial.findMany({
        where: { userId: u.id },
        select: { id: true, status: true, trialAt: true, academy: { select: { name: true } } },
        orderBy: { trialAt: 'desc' },
        take: 20,
      }),
      enrollments: await prisma.enrollment.findMany({
        where: { userId: u.id },
        select: { id: true, status: true, batch: { select: { title: true } } },
        take: 20,
      }),
      payments: await userPayments(u.id),
    })),
  );

  const academies = await prisma.academy.findMany({
    where: { name: { contains: q, mode: 'insensitive' } },
    take: 5,
    select: {
      id: true,
      name: true,
      branchLabel: true,
      status: true,
      verified: true,
      // KYC lives on the payee now, and one payee can back several branches.
      group: { select: { id: true, name: true } },
      financialEntity: { select: { id: true, bankKycStatus: true } },
    },
  });

  return { users: usersWith360, academies };
}

// ---------- Safe actions ----------

export async function cancelBooking(actorId: string, bookingId: string) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new AppError('NOT_FOUND', 404, 'Booking not found');
  const before = { status: booking.status };
  const updated = await prisma.$transaction(async (tx) => {
    // Trial bookings run off batch capacity + trialAt, not the legacy Slot model, so cancelling
    // just marks the booking — there is no slot to free.
    const b = await tx.booking.update({
      where: { id: bookingId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await writeAudit(
      { adminId: actorId, action: 'support.cancel_booking', targetType: 'Booking', targetId: bookingId, before, after: { status: 'cancelled' } },
      tx,
    );
    return b;
  });
  return { booking: updated };
}

export async function cancelEnrollment(actorId: string, enrollmentId: string) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  const before = { status: enrollment.status };
  // EnrollmentStatus is active|inactive; cancelling deactivates the enrollment.
  const updated = await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: { status: 'inactive' },
  });
  await writeAudit({ adminId: actorId, action: 'support.cancel_enrollment', targetType: 'Enrollment', targetId: enrollmentId, before, after: { status: 'inactive' } });
  return { enrollment: updated };
}

// Re-trigger a login OTP for the user's phone (support: "I didn't get my code").
export async function resendOtp(actorId: string, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
  if (!user?.phone) throw new AppError('BAD_REQUEST', 400, 'User has no phone on file');
  const res = await requestOtp({ phone: user.phone, role: 'student' });
  await writeAudit({ adminId: actorId, action: 'support.resend_otp', targetType: 'User', targetId: userId });
  return { otp_id: res.otp_id };
}

export async function resendPush(actorId: string, args: { subjectId: string; role: 'student' | 'academy'; title: string; body: string }) {
  const res = await sendPushNotifications({ subjectId: args.subjectId, subjectRole: args.role, title: args.title, body: args.body });
  await writeAudit({ adminId: actorId, action: 'support.resend_push', targetType: args.role === 'academy' ? 'Academy' : 'User', targetId: args.subjectId, after: { sent: res.sent } });
  return res;
}

// Unstick bookings wedged in a pre-confirmation state past their reservation expiry: cancel them
// and free the held slot so the batch capacity isn't leaked.
export async function unstickBooking(actorId: string, bookingId: string) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new AppError('NOT_FOUND', 404, 'Booking not found');
  if (booking.status !== 'initiated' && booking.status !== 'paid') {
    throw new AppError('BAD_REQUEST', 400, `Booking is not stuck (status=${booking.status})`);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const b = await tx.booking.update({
      where: { id: bookingId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await writeAudit(
      { adminId: actorId, action: 'support.unstick_booking', targetType: 'Booking', targetId: bookingId, before: { status: booking.status }, after: { status: 'cancelled' } },
      tx,
    );
    return b;
  });
  return { booking: updated };
}
