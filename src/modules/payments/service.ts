import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import * as repo from './repo.js';

// Lazily constructed & cached — avoids paying the `import('razorpay')` cost on every
// request, and avoids constructing a client with empty keys when running mocked/unconfigured.
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
  const razorpayClient = await getRazorpay();
  const refund = await razorpayClient.payments.refund(razorpayPaymentId, { amount: amountPaise, speed: 'optimum' });
  return refund.id as string;
}

// NOTE (Group F / F6 follow-on): only the trial `/payments/order` path below
// returns a server-computed `breakdown`. The workshop / event / enrollment order
// builders (createWorkshopOrder / createEnrollmentOrder / createEventOrder and
// their respective module repos) do NOT yet return a breakdown — that is a
// deliberate, deferred follow-on, not an oversight.
export async function createOrder({ bookingId }: { bookingId: string }) {
  const booking = await repo.findBookingWithSlot(bookingId);
  if (!booking) throw new AppError('NOT_FOUND', 404, 'Booking not found');
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

  // Fallback id used when Razorpay isn't configured (local/dev) — keeps the booking
  // flow working end-to-end without a real payment gateway.
  let razorpayOrderId = `order_${newId().slice(0, 12)}`;

  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const razorpayClient = await getRazorpay();
    const order = await razorpayClient.orders.create({
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

import { sendPushNotifications } from '../push/service.js';
import * as workshopRepo from '../workshops/repo.js';
import { accrueReserveOnCapture } from '../settlement/service.js';

// Razorpay sends the same webhook shape for every payment type; we don't know which of our
// three "payment" tables (enrollment / event / workshop / trial booking) a given order_id
// belongs to until we look it up, so we just try each one in turn and handle whichever matches.
export async function handleWebhook(body: Record<string, unknown>, signature: string, rawBody?: string) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET || '';
  if (secret) {
    const payload = rawBody ?? JSON.stringify(body);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid webhook signature');
    }
  }

  const event = body.event as string;
  const payloadEntity = (body.payload as any)?.payment?.entity;
  if (!payloadEntity) return { received: true };

  const orderId = payloadEntity.order_id as string;
  if (!orderId) return { received: true };

  // Enrollment (monthly/quarterly/annual class package) payment
  const enrollmentPayment = await repo.findEnrollmentPaymentByOrderId(orderId);
  if (enrollmentPayment) {
    // Idempotency guard: Razorpay retries webhook delivery, so a payment we've already
    // resolved (captured or failed) must be a no-op, not double-processed.
    if (enrollmentPayment.status === 'captured' || enrollmentPayment.status === 'failed') return { received: true };
    if (event === 'payment.captured') {
      await prisma.$transaction(async (tx) => {
        await repo.updateEnrollmentPaymentCaptured(enrollmentPayment.id, payloadEntity.id as string, tx);
        await repo.activateEnrollmentPeriod(enrollmentPayment.enrollmentPeriodId, enrollmentPayment.enrollmentPeriod.enrollmentId, tx);
        // S2.4: commission on the enrolment payment (taken from the academy payout).
        await repo.recordCommission({
          academyId: enrollmentPayment.enrollmentPeriod.enrollment.batch.academyId,
          itemType: 'enrollment',
          itemId: enrollmentPayment.enrollmentPeriodId,
          grossPaise: enrollmentPayment.amountPaise,
        }, tx);
        // S7: withhold the rolling reserve from this captured revenue.
        await accrueReserveOnCapture({
          academyId: enrollmentPayment.enrollmentPeriod.enrollment.batch.academyId,
          grossPaise: enrollmentPayment.amountPaise,
          sourceType: 'enrollment',
          sourceId: enrollmentPayment.enrollmentPeriodId,
        }, tx);
      });
      const enrollment = enrollmentPayment.enrollmentPeriod.enrollment;
      const packageMonths = ({ monthly: 1, quarterly: 3, annual: 12 } as Record<string, number>)[enrollmentPayment.enrollmentPeriod.packageType] ?? 1;
      try {
        await sendPushNotifications({
          subjectId: enrollment.userId,
          subjectRole: 'student',
          title: 'Enrollment confirmed',
          body: `Your ${enrollment.batch.title} enrollment is active for ${packageMonths} month${packageMonths > 1 ? 's' : ''}.`,
          data: { screen: 'enrollments' },
        });
      } catch { /* non-fatal */ }
    } else if (event === 'payment.failed') {
      await repo.updateEnrollmentPaymentFailed(enrollmentPayment.id);
      const enrollment = enrollmentPayment.enrollmentPeriod.enrollment;
      try {
        await sendPushNotifications({
          subjectId: enrollment.userId,
          subjectRole: 'student',
          title: 'Payment failed',
          body: 'Your enrollment payment failed. Please try again.',
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
        await repo.confirmEventRegistration(evPayment.registrationId, tx);
        await repo.incrementEventEnrolledCount(evPayment.registration.eventId, tx);
        // S4.5: NO commission — events are Findemy-organised (Event has no academyId);
        // the platform keeps 100% of event revenue. (If events become academy-hosted, mirror S4.4.)
      });
      try {
        await sendPushNotifications({
          subjectId: evPayment.registration.userId,
          subjectRole: 'student',
          title: 'Registration confirmed',
          body: `You're registered for "${evPayment.registration.event.title}".`,
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
        await workshopRepo.confirmRegistration(wsPayment.registrationId, tx);
        await workshopRepo.incrementRegisteredCount(wsPayment.registration.workshopId, tx);
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
          body: `You're registered for "${wsPayment.registration.workshop.title}".`,
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
        body: `${payment.booking.user.name} booked a trial`,
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
        body: `Your trial at ${payment.booking.batch.academy?.name ?? 'the academy'} on ${dateStr} is set.`,
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
