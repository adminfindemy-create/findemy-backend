import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import * as repo from './repo.js';
import { whose } from '../../lib/learner-access.js';

let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID || '',
    key_secret: env.RAZORPAY_KEY_SECRET || '',
  });
  return razorpayInstance;
}

export async function issueRazorpayRefund(razorpayPaymentId: string, amountPaise: number): Promise<string> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return `refund_mock_${newId().slice(0, 12)}`;
  }
  const rp = await getRazorpay();
  const refund = await rp.payments.refund(razorpayPaymentId, { amount: amountPaise, speed: 'optimum' });
  return refund.id as string;
}

// NOTE (Group F / F6 follow-on): only the trial `/payments/order` path below
// returns a server-computed `breakdown`. The workshop / event / enrollment order
// builders (createWorkshopOrder / createEnrollmentOrder / createEventOrder and
// their respective module repos) do NOT yet return a breakdown — that is a
// deliberate, deferred follow-on, not an oversight.
export async function createOrder({ bookingId, userId }: { bookingId: string; userId: string }) {
  const booking = await repo.findBookingWithSlot(bookingId);
  // Someone else's booking reads as missing, so ids can't be probed.
  if (!booking || booking.userId !== userId) throw new AppError('NOT_FOUND', 404, 'Booking not found');
  if (booking.status !== 'initiated') {
    throw new AppError('VALIDATION', 400, 'Booking not in initiated state');
  }

  const amountPaise = booking.batch.trialFeePaise;

  // Server-authoritative price breakdown (paise). The learner pays the trial fee;
  // Findemy's commission is taken from the academy payout (S2.4 — commission ledger),
  // not added to the learner's price. (S0.2 removed the hardcoded platform-fee/credits rule.)
  const breakdown = {
    base_paise: amountPaise,
    total_paise: amountPaise,
  };

  // A free trial has nothing to charge, and Razorpay rejects orders under ₹1. No order is
  // made; the client confirms through `confirmFreeBooking` instead.
  if (amountPaise <= 0) {
    return {
      free: true as const,
      razorpay_order_id: null,
      razorpay_key: null,
      amount_paise: 0,
      currency: 'INR',
      breakdown,
    };
  }

  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${bookingId}:${amountPaise}`)
    .digest('hex');

  const existing = await (repo as any).findPaymentByIdempotencyKey?.(idempotencyKey);
  if (existing) {
    return {
      razorpay_order_id: existing.razorpayOrderId,
      razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx',
      amount_paise: existing.amountPaise,
      currency: existing.currency,
      breakdown,
    };
  }

  let razorpayOrderId = `order_${newId().slice(0, 12)}`;

  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const rp = await getRazorpay();
    const order = await rp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: bookingId,
      notes: { booking_id: bookingId, payment_type: 'booking' },
    });
    razorpayOrderId = order.id;
  }

  await repo.createPayment({
    id: newId(),
    bookingId,
    amountPaise,
    currency: 'INR',
    razorpayOrderId,
    idempotencyKey,
  });

  return {
    razorpay_order_id: razorpayOrderId,
    razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx',
    amount_paise: amountPaise,
    currency: 'INR',
    breakdown,
  };
}

/**
 * Confirm a free trial (batch trial fee is 0) without a payment. Mirrors the trial branch of
 * the capture webhook, minus the money: no payment row, no commission, no reserve.
 */
export async function confirmFreeBooking({ bookingId, userId }: { bookingId: string; userId: string }) {
  const booking = await repo.findBookingForFreeConfirm(bookingId);
  if (!booking || booking.userId !== userId) throw new AppError('NOT_FOUND', 404, 'Booking not found');
  if (booking.batch.trialFeePaise > 0) {
    throw new AppError('VALIDATION', 400, 'This trial is not free');
  }
  if (booking.status === 'confirmed') return { booking_id: bookingId, status: 'confirmed' };
  if (booking.status !== 'initiated') {
    throw new AppError('VALIDATION', 400, 'Booking not in initiated state');
  }

  const confirmed = await prisma.$transaction(async (tx) => {
    // Conditional flip, so a double tap can't create two trials.
    const flipped = await tx.booking.updateMany({
      where: { id: bookingId, status: 'initiated' },
      data: { status: 'confirmed', paidAt: new Date() },
    });
    if (flipped.count === 0) return false;
    await repo.createTrial({
      id: newId(),
      userId: booking.userId,
      learnerId: booking.learnerId,
      academyId: booking.batch.academyId,
      batchId: booking.batchId,
      bookingId,
      trialAt: booking.trialAt ?? new Date(),
    }, tx);
    return true;
  });
  if (!confirmed) return { booking_id: bookingId, status: 'confirmed' };

  try {
    await sendPushNotifications({
      subjectId: booking.batch.academyId,
      subjectRole: 'academy',
      title: 'New trial booked',
      body: booking.learner && !booking.learner.selfOf
        ? `${booking.user.name} booked a trial for ${booking.learner.name}`
        : `${booking.user.name} booked a trial`,
      data: { type: 'trial:new', trial_id: bookingId },
    });
  } catch { /* non-fatal */ }
  try {
    const trialAt = booking.trialAt ?? new Date();
    const dateStr = trialAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    await sendPushNotifications({
      subjectId: booking.userId,
      subjectRole: 'student',
      title: 'Booking confirmed',
      body: `${whose(booking.learner)} trial at ${booking.batch.academy?.name ?? 'the academy'} on ${dateStr} is set.`,
      data: { screen: 'trials' },
    });
  } catch { /* non-fatal */ }

  return { booking_id: bookingId, status: 'confirmed' };
}

import { sendPushNotifications } from '../push/service.js';
import * as workshopRepo from '../workshops/repo.js';
import { accrueReserveOnCapture } from '../settlement/service.js';

export async function handleWebhook(body: Record<string, unknown>, signature: string, rawBody?: string) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET || '';
  if (secret) {
    const payload = rawBody ?? JSON.stringify(body);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    // Length check FIRST: `timingSafeEqual` throws on mismatched buffers, so a missing or
    // truncated header crashed out as a 500 instead of rejecting. A 500 also makes Razorpay
    // retry a request that can never succeed. (rooms/service.ts already guards this way.)
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid webhook signature');
    }
  }

  const event = body.event as string;
  const payloadEntity = (body.payload as any)?.payment?.entity;
  if (!payloadEntity) return { received: true };

  const orderId = payloadEntity.order_id as string;
  if (!orderId) return { received: true };

  // Enrollment payment
  const epPayment = await repo.findEnrollmentPaymentByOrderId(orderId);
  if (epPayment) {
    if (epPayment.status === 'captured' || epPayment.status === 'failed') return { received: true };
    if (event === 'payment.captured') {
      await prisma.$transaction(async (tx) => {
        await repo.updateEnrollmentPaymentCaptured(epPayment.id, payloadEntity.id as string, tx);
        await repo.activateEnrollmentPeriod(epPayment.enrollmentPeriodId, epPayment.enrollmentPeriod.enrollmentId, tx);
        // S2.4: commission on the enrolment payment (taken from the academy payout).
        await repo.recordCommission({
          academyId: epPayment.enrollmentPeriod.enrollment.batch.academyId,
          itemType: 'enrollment',
          itemId: epPayment.enrollmentPeriodId,
          grossPaise: epPayment.amountPaise,
        }, tx);
        // S7: withhold the rolling reserve from this captured revenue.
        await accrueReserveOnCapture({
          academyId: epPayment.enrollmentPeriod.enrollment.batch.academyId,
          grossPaise: epPayment.amountPaise,
          sourceType: 'enrollment',
          sourceId: epPayment.enrollmentPeriodId,
        }, tx);
      });
      const enrollment = epPayment.enrollmentPeriod.enrollment;
      const months = ({ monthly: 1, quarterly: 3, annual: 12 } as Record<string, number>)[epPayment.enrollmentPeriod.packageType] ?? 1;
      try {
        await sendPushNotifications({
          subjectId: enrollment.userId,
          subjectRole: 'student',
          title: 'Enrollment confirmed',
          body: `${whose(enrollment.learner)} ${enrollment.batch.title} enrollment is active for ${months} month${months > 1 ? 's' : ''}.`,
          data: { screen: 'enrollments' },
        });
      } catch { /* non-fatal */ }
    } else if (event === 'payment.failed') {
      await repo.updateEnrollmentPaymentFailed(epPayment.id);
      const enrollment = epPayment.enrollmentPeriod.enrollment;
      try {
        await sendPushNotifications({
          subjectId: enrollment.userId,
          subjectRole: 'student',
          title: 'Payment failed',
          body: `The payment for ${whose(enrollment.learner, { lower: true })} ${enrollment.batch.title} enrollment failed. Please try again.`,
          data: { screen: 'enrollments' },
        });
      } catch { /* non-fatal */ }
    }
    return { received: true };
  }

  // Event payment
  const evPayment = await repo.findEventPaymentByOrderId(orderId);
  if (evPayment) {
    if (evPayment.status === 'captured' || evPayment.status === 'failed') return { received: true };
    if (event === 'payment.captured') {
      await prisma.$transaction(async (tx) => {
        await repo.updateEventPaymentCaptured(evPayment.id, payloadEntity.id as string, tx);
        // Confirm exactly the tickets this order was priced for, and take that many places.
        await repo.confirmEventRegistration(evPayment.registrationId, tx, evPayment.quantity ?? 1);
        await repo.incrementEventEnrolledCount(evPayment.registration.eventId, tx, evPayment.quantity ?? 1);
        // S4.5: NO commission — events are Findemy-organised (Event has no academyId);
        // the platform keeps 100% of event revenue. (If events become academy-hosted, mirror S4.4.)
      });
      try {
        await sendPushNotifications({
          subjectId: evPayment.registration.userId,
          subjectRole: 'student',
          title: 'Registration confirmed',
          body: (evPayment.quantity ?? 1) > 1
            ? `You're registered for "${evPayment.registration.event.title}" (${evPayment.quantity} ${evPayment.registration.event.type === 'competition' ? 'participants' : 'tickets'}).`
            : `You're registered for "${evPayment.registration.event.title}".`,
          data: { screen: 'events' },
        });
      } catch { /* non-fatal */ }
    } else if (event === 'payment.failed') {
      await repo.updateEventPaymentFailed(evPayment.id);
    }
    return { received: true };
  }

  // Workshop payment
  const wsPayment = await workshopRepo.findWorkshopPaymentByOrderId(orderId);
  if (wsPayment) {
    if (wsPayment.status === 'captured' || wsPayment.status === 'failed') return { received: true };
    if (event === 'payment.captured') {
      await prisma.$transaction(async (tx) => {
        await workshopRepo.updateWorkshopPaymentCaptured(wsPayment.id, payloadEntity.id as string, tx);
        // Confirm exactly the tickets this order was priced for, and take that many seats.
        await workshopRepo.confirmRegistration(wsPayment.registrationId, tx, wsPayment.quantity ?? 1);
        await workshopRepo.incrementRegisteredCount(wsPayment.registration.workshopId, tx, wsPayment.quantity ?? 1);
        // S4.4: commission on the workshop payment (taken from the academy payout), parity with trial/enrol.
        await repo.recordCommission({
          academyId: wsPayment.registration.workshop.academyId,
          itemType: 'workshop',
          itemId: wsPayment.id,
          grossPaise: wsPayment.amountPaise,
        }, tx);
        // S7: withhold the rolling reserve from this captured revenue.
        await accrueReserveOnCapture({
          academyId: wsPayment.registration.workshop.academyId,
          grossPaise: wsPayment.amountPaise,
          sourceType: 'workshop',
          sourceId: wsPayment.id,
        }, tx);
      });
      try {
        await sendPushNotifications({
          subjectId: wsPayment.registration.userId,
          subjectRole: 'student',
          title: 'Workshop registration confirmed',
          body: (wsPayment.quantity ?? 1) > 1
            ? `You're registered for "${wsPayment.registration.workshop.title}" (${wsPayment.quantity} tickets).`
            : `You're registered for "${wsPayment.registration.workshop.title}".`,
          data: { screen: 'workshops' },
        });
      } catch { /* non-fatal */ }
    } else if (event === 'payment.failed') {
      await workshopRepo.updateWorkshopPaymentFailed(wsPayment.id);
    }
    return { received: true };
  }

  // Trial booking payment
  const payment = await repo.findPaymentByOrderId(orderId);
  if (!payment) return { received: true };

  if (payment.status === 'captured' || payment.status === 'failed') return { received: true };

  if (event === 'payment.captured') {
    await prisma.$transaction(async (tx) => {
      await repo.updatePaymentCaptured(payment.id, payloadEntity.id as string, tx);
      await repo.confirmBooking(payment.bookingId, tx);
      await repo.createTrial({
        id: newId(),
        userId: payment.booking.userId,
        learnerId: payment.booking.learnerId,
        academyId: payment.booking.batch.academyId,
        batchId: payment.booking.batchId,
        bookingId: payment.bookingId,
        // S2.1: trial time is the booking's chosen class session (no slot).
        trialAt: payment.booking.trialAt ?? new Date(),
      }, tx);
      // S2.4: commission on the trial payment (taken from the academy payout).
      await repo.recordCommission({
        academyId: payment.booking.batch.academyId,
        itemType: 'trial',
        itemId: payment.bookingId,
        grossPaise: payment.amountPaise,
      }, tx);
      // S7: withhold the rolling reserve from this captured revenue.
      await accrueReserveOnCapture({
        academyId: payment.booking.batch.academyId,
        grossPaise: payment.amountPaise,
        sourceType: 'trial',
        sourceId: payment.bookingId,
      }, tx);
    });
    try {
      await sendPushNotifications({
        subjectId: payment.booking.batch.academyId,
        subjectRole: 'academy',
        title: 'New trial booked',
        // The learner is who walks in; for a child, say who booked so the desk knows the parent.
        body: payment.booking.learner && !payment.booking.learner.selfOf
          ? `${payment.booking.user.name} booked a trial for ${payment.booking.learner.name}`
          : `${payment.booking.user.name} booked a trial`,
        data: { type: 'trial:new', trial_id: payment.bookingId },
      });
    } catch { /* non-fatal */ }
    try {
      const trialAt = payment.booking.trialAt ?? new Date();
      const dateStr = trialAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      await sendPushNotifications({
        subjectId: payment.booking.userId,
        subjectRole: 'student',
        title: 'Booking confirmed',
        body: `${whose(payment.booking.learner)} trial at ${payment.booking.batch.academy?.name ?? 'the academy'} on ${dateStr} is set.`,
        data: { screen: 'trials' },
      });
    } catch { /* non-fatal */ }
  } else if (event === 'payment.failed') {
    // S2.1: no slot to release; the booking simply stays unconfirmed.
    await repo.updatePaymentFailed(payment.id);
  }

  return { received: true };
}

export async function getPayment(id: string) {
  const payment = await repo.findPaymentById(id);
  if (!payment) throw new AppError('NOT_FOUND', 404, 'Payment not found');
  return {
    payment: {
      id: payment.id,
      booking_id: payment.bookingId,
      amount_paise: payment.amountPaise,
      currency: payment.currency,
      razorpay_order_id: payment.razorpayOrderId,
      razorpay_payment_id: payment.razorpayPaymentId,
      status: payment.status,
      created_at: payment.createdAt.toISOString(),
      captured_at: payment.capturedAt?.toISOString() ?? null,
    },
  };
}
