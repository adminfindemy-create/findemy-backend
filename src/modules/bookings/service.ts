import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import { TRIAL_REFUND_MIN_HOURS } from '../../config.js';
import * as repo from './repo.js';

export async function createBooking({
  userId,
  batchId,
  trialAt,
}: {
  userId: string;
  batchId: string;
  trialAt: string;
}) {
  // S2.1: book a trial against capacity − enrolled at one of the batch's class sessions
  // (no published slots). A booked trial does NOT consume a spot (headroom is enrolments only).
  const { assertValidTrialTime, getBatchAvailability } = await import('../batches/service.js');
  const validTrialAt = await assertValidTrialTime(batchId, trialAt);
  const avail = await getBatchAvailability(batchId);
  if (!avail.accepting || avail.available <= 0) {
    throw new AppError('BATCH_FULL', 409, 'No trial spots available for this batch');
  }
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, select: { trialFeePaise: true } });

  const result = await repo.createBooking({
    id: newId(),
    userId,
    batchId,
    trialAt: validTrialAt,
    status: 'initiated',
    reservationExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  // Mock payment intent for now
  const paymentIntent = {
    razorpay_order_id: `order_${newId().slice(0, 12)}`,
    razorpay_key: process.env.RAZORPAY_KEY_ID || 'rzp_test_xxx',
    amount_paise: batch?.trialFeePaise ?? 0,
    currency: 'INR',
  };

  return {
    booking: {
      id: result.id,
      user_id: result.userId,
      batch_id: result.batchId,
      trial_at: result.trialAt?.toISOString() ?? null,
      status: result.status,
      reschedule_count: result.rescheduleCount,
      reservation_expires_at: result.reservationExpiresAt.toISOString(),
      created_at: result.createdAt.toISOString(),
      paid_at: result.paidAt?.toISOString() ?? null,
      cancelled_at: result.cancelledAt?.toISOString() ?? null,
    },
    payment_intent: paymentIntent,
  };
}

export async function getBooking(id: string, userId: string) {
  const booking = await repo.findBookingByIdAndUser(id, userId);
  if (!booking) throw new AppError('NOT_FOUND', 404, 'Booking not found');
  const batch = (booking as any).batch;
  const academy = batch?.academy;
  return {
    booking: {
      id: booking.id,
      user_id: booking.userId,
      batch_id: booking.batchId,
      slot_id: booking.slotId,
      // S2.1: trial time is canonical on the booking (slots retired). Payment/confirmation
      // screens read this for the "When" row.
      trial_at: booking.trialAt?.toISOString() ?? null,
      status: booking.status,
      reschedule_count: booking.rescheduleCount,
      reservation_expires_at: booking.reservationExpiresAt.toISOString(),
      created_at: booking.createdAt.toISOString(),
      paid_at: booking.paidAt?.toISOString() ?? null,
      cancelled_at: booking.cancelledAt?.toISOString() ?? null,
      batch: batch ? { id: batch.id, title: batch.title, category: batch.category, mode: batch.mode } : null,
      academy: academy
        ? { id: academy.id, name: academy.name, address: academy.address, category: academy.category, images: academy.images }
        : null,
    },
  };
}

export async function cancelBooking(
  id: string,
  userId: string,
  opts: { acknowledgeNoRefund?: boolean; reason?: string } = {},
) {
  const booking = await repo.findBookingByIdAndUser(id, userId);
  if (!booking) throw new AppError('NOT_FOUND', 404, 'Booking not found');

  if (booking.status === 'cancelled') {
    throw new AppError('ALREADY_CANCELLED', 400, 'This trial is already cancelled.');
  }

  if (booking.rescheduleCount > 0 || booking.status === 'rescheduled') {
    throw new AppError(
      'CANCEL_AFTER_RESCHEDULE_FORBIDDEN',
      400,
      "Rescheduled trials can't be cancelled. Please reach out to the academy.",
    );
  }

  if (!['initiated', 'paid', 'confirmed'].includes(booking.status)) {
    throw new AppError('VALIDATION', 400, 'Cannot cancel this booking');
  }

  // S2.1: trial time is booking.trialAt (legacy bookings fall back to slot.slotTime).
  const trialTime = booking.trialAt ?? booking.slot?.slotTime ?? new Date();
  const hoursUntilSlot = (trialTime.getTime() - Date.now()) / (1000 * 60 * 60);
  const isPaid = booking.payment?.status === 'captured' && !!booking.payment.razorpayPaymentId;
  const refundEligible = isPaid && hoursUntilSlot >= TRIAL_REFUND_MIN_HOURS;

  if (isPaid && !refundEligible && !opts.acknowledgeNoRefund) {
    throw new AppError(
      'ACK_REQUIRED',
      422,
      'Cancellations within 4 hours of the trial are non-refundable. Acknowledge to proceed.',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const b = await repo.cancelBooking(id, tx);
    await repo.cancelTrialForBooking(id, tx);
    return b;
  });

  let refundInitiated = false;
  let refundAmountPaise = 0;
  if (refundEligible && booking.payment) {
    try {
      const { issueRazorpayRefund } = await import('../payments/service.js');
      const { updatePaymentRefunded } = await import('../payments/repo.js');
      const refundId = await issueRazorpayRefund(
        booking.payment.razorpayPaymentId!,
        booking.payment.amountPaise,
      );
      await updatePaymentRefunded(booking.payment.id, refundId, booking.payment.amountPaise);
      // S2.4: reverse the trial commission (full refund → fully reversed).
      const { reverseCommission } = await import('../payments/repo.js');
      await reverseCommission('trial', id, booking.payment.amountPaise);
      refundInitiated = true;
      refundAmountPaise = booking.payment.amountPaise;
    } catch { /* non-fatal; reconcile worker will retry */ }
  }

  return {
    booking: {
      id: updated.id,
      user_id: updated.userId,
      batch_id: updated.batchId,
      trial_at: updated.trialAt?.toISOString() ?? null,
      status: updated.status,
      reschedule_count: updated.rescheduleCount,
      reservation_expires_at: updated.reservationExpiresAt.toISOString(),
      created_at: updated.createdAt.toISOString(),
      paid_at: updated.paidAt?.toISOString() ?? null,
      cancelled_at: updated.cancelledAt?.toISOString() ?? null,
    },
    refund_eligible: refundEligible,
    refund_initiated: refundInitiated,
    refund_amount_paise: refundAmountPaise,
  };
}

export async function rescheduleBooking(
  id: string,
  userId: string,
  newTrialAt: string,
) {
  const booking = await repo.findBookingByIdAndUser(id, userId);
  if (!booking) throw new AppError('NOT_FOUND', 404, 'Booking not found');
  if (booking.status !== 'confirmed') {
    throw new AppError('VALIDATION', 400, 'Booking not confirmed');
  }
  if (booking.rescheduleCount >= 1) {
    throw new AppError('RESCHEDULE_LIMIT', 409, 'Already rescheduled once');
  }

  // S2.1: new time must be one of the batch's upcoming class sessions.
  const { assertValidTrialTime } = await import('../batches/service.js');
  const validTrialAt = await assertValidTrialTime(booking.batchId, newTrialAt);

  const updated = await repo.rescheduleBooking(id, validTrialAt);

  return {
    booking: {
      id: updated.id,
      user_id: updated.userId,
      batch_id: updated.batchId,
      trial_at: updated.trialAt?.toISOString() ?? null,
      status: updated.status,
      reschedule_count: updated.rescheduleCount,
      reservation_expires_at: updated.reservationExpiresAt.toISOString(),
      created_at: updated.createdAt.toISOString(),
      paid_at: updated.paidAt?.toISOString() ?? null,
      cancelled_at: updated.cancelledAt?.toISOString() ?? null,
    },
  };
}
