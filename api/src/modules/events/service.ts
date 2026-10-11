import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import * as repo from './repo.js';
import {
  MAX_TICKETS,
  resolveCompetitionParticipants,
  resolveTicketAttendees,
  serializeAttendee,
  type AttendeeInput,
} from '../../lib/tickets.js';

function serialize(e: any) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    category: e.category,
    description: e.description,
    start_at: e.startAt.toISOString(),
    end_at: e.endAt.toISOString(),
    location: e.location,
    /** offline | online | hybrid. Replaces guessing from the `location` string. */
    mode: e.mode ?? 'offline',
    lat: e.lat,
    lng: e.lng,
    capacity: e.capacity,
    enrolled_count: e.enrolledCount,
    price_paise: e.pricePaise ?? 0,
    organizer_name: e.organizerName,
    cover_color: e.coverColor,
    cover_image_url: e.coverImageUrl ?? null,
    gallery_image_urls: e.galleryImageUrls ?? [],
    registration_opens_at: e.registrationOpensAt?.toISOString() ?? null,
    registration_deadline: e.registrationDeadline?.toISOString() ?? null,
    prize_paise: e.prizePaise ?? null,
    is_spotlight: e.isSpotlight ?? false,
    status: e.status ?? 'scheduled',
    spots_left: e.capacity != null ? Math.max(e.capacity - e.enrolledCount, 0) : null,
    divisions: e.divisions ?? [],
    created_at: e.createdAt.toISOString(),
  };
}

export async function listEvents(type?: string) {
  const events = await repo.findEvents(type);
  return { items: events.map(serialize), next_cursor: null };
}

export async function getEvent(id: string) {
  const event = await repo.findEventById(id);
  if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');
  return { event: serialize(event) };
}

export async function getRegistrationStatus(eventId: string, userId: string) {
  const reg = await repo.findRegistration(eventId, userId);
  return {
    registered: !!reg,
    status: reg?.status ?? null,
    registration_id: reg?.id ?? null,
    quantity: reg?.quantity ?? null,
    attendees: (reg?.attendees ?? []).map(serializeAttendee),
  };
}

let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID || '', key_secret: env.RAZORPAY_KEY_SECRET || '' });
  return razorpayInstance;
}

export async function registerForEvent(
  eventId: string,
  userId: string,
  input: { attendees?: AttendeeInput[]; learner_ids?: unknown } = {},
) {
  const event = await repo.findEventById(eventId);
  if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');

  const deadline = (event as any).registrationDeadline;
  if (deadline && new Date() > deadline) {
    throw new AppError('REGISTRATION_CLOSED', 400, 'Registration deadline has passed');
  }

  const existing = await repo.findRegistration(eventId, userId);
  if (existing?.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already registered');
  // A cancelled booking that was paid keeps its payment (and refund) record, and a booking has
  // room for one payment — so it can't be paid for a second time.
  if (existing?.status === 'cancelled' && existing.payment?.status === 'captured') {
    throw new AppError('REBOOK_NOT_SUPPORTED', 409, 'You cancelled a paid booking for this event, so it can’t be booked again');
  }

  // Competitions take participants from the family account (parent, child or both); meetups and
  // workshop events take named tickets — one for an online-only event, which only the account
  // holder can join.
  const attendees = event.type === 'competition'
    ? await resolveCompetitionParticipants(userId, eventId, input.learner_ids, existing?.id)
    : await resolveTicketAttendees(userId, input.attendees, event.mode === 'online' ? 1 : MAX_TICKETS);
  const quantity = attendees.length;

  if (event.capacity !== null) {
    const left = Math.max(event.capacity - event.enrolledCount, 0);
    if (left === 0) throw new AppError('VALIDATION', 400, 'Event is full');
    if (quantity > left) throw new AppError('NOT_ENOUGH_SEATS', 400, `Only ${left} place${left === 1 ? '' : 's'} left`);
  }

  const reg = await repo.savePendingRegistration(eventId, userId, attendees, existing?.id);
  const pricePaise = event.pricePaise ?? 0;

  if (pricePaise === 0) {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.$transaction(async (tx: any) => {
      await repo.confirmRegistration(reg.id, tx, quantity);
      await repo.incrementEnrolledCount(eventId, tx, quantity);
    });
    return { registration_id: reg.id, requires_payment: false, amount_paise: 0, quantity };
  }

  return { registration_id: reg.id, requires_payment: true, amount_paise: pricePaise * quantity, quantity };
}

export async function createEventPaymentOrder(registrationId: string, userId: string) {
  const reg = await repo.findRegistrationById(registrationId);
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (reg.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already confirmed');

  const quantity: number = reg.quantity ?? 1;
  const amountPaise = reg.event.pricePaise * quantity;
  const idempotencyKey = crypto.createHash('sha256').update(`ev:${registrationId}:${amountPaise}`).digest('hex');
  const key = env.RAZORPAY_KEY_ID || 'rzp_test_xxx';

  // One payment row per booking. Same amount → reuse its order; a changed ticket count → a fresh
  // order on the same row (only while it is unpaid).
  const existing = await repo.findEventPaymentByRegistration(registrationId);
  if (existing && existing.idempotencyKey === idempotencyKey) {
    return { razorpay_order_id: existing.razorpayOrderId, razorpay_key: key, amount_paise: existing.amountPaise, currency: existing.currency, quantity: existing.quantity };
  }
  if (existing && existing.status === 'captured') {
    throw new AppError('VALIDATION', 400, 'This booking is already paid');
  }

  let razorpayOrderId = `order_ev_${newId().slice(0, 12)}`;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const rp = await getRazorpay();
    const order = await rp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: registrationId,
      notes: { event_registration_id: registrationId, payment_type: 'event', tickets: String(quantity) },
    });
    razorpayOrderId = order.id;
  }

  if (existing) {
    await repo.replaceEventPaymentOrder(existing.id, { amountPaise, quantity, razorpayOrderId, idempotencyKey });
  } else {
    await repo.createEventPayment({ id: newId(), registrationId, amountPaise, quantity, currency: 'INR', razorpayOrderId, idempotencyKey });
  }

  return { razorpay_order_id: razorpayOrderId, razorpay_key: key, amount_paise: amountPaise, currency: 'INR', quantity };
}

export async function cancelEventRegistration(registrationId: string, userId: string) {
  const reg = await repo.findRegistrationById(registrationId);
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (reg.status === 'cancelled') throw new AppError('VALIDATION', 400, 'Already cancelled');
  if (reg.status !== 'confirmed') throw new AppError('VALIDATION', 400, 'Registration not confirmed');

  const event = reg.event;
  const now = Date.now();

  // Determine cancellation window based on event type
  const deadline: Date | null = event.registrationDeadline ?? null;
  const { WORKSHOP_REFUND_MIN_HOURS } = await import('../../config.js');
  const hoursUntilStart = (event.startAt.getTime() - now) / (1000 * 60 * 60);

  if (event.type === 'competition') {
    // Non-refundable; only cancellable before registration deadline
    const cutoff = deadline ?? new Date(event.startAt.getTime() - 48 * 60 * 60 * 1000);
    if (now > cutoff.getTime()) {
      throw new AppError('CANCELLATION_WINDOW_CLOSED', 400, 'Registration deadline has passed — cancellation not allowed');
    }
  } else if (event.type === 'meetup') {
    // meetup: 2 hours before event start
    const cutoff = new Date(event.startAt.getTime() - 2 * 60 * 60 * 1000);
    if (now > cutoff.getTime()) {
      throw new AppError('CANCELLATION_WINDOW_CLOSED', 400, 'Cannot cancel within 2 hours of the event');
    }
  }
  // workshop: cancellable anytime — refund is gated on the 24h window below.

  const { prisma } = await import('../../lib/prisma.js');
  await prisma.$transaction(async (tx: any) => {
    // The whole booking goes: every ticket / participant in it is released.
    await repo.cancelRegistration(registrationId, tx);
    await repo.decrementEnrolledCount(event.id, tx, reg.quantity ?? 1);
  });

  // Refund policy: meetups (passed the 2h gate above) and workshops cancelled ≥24h before start.
  // Competitions are non-refundable in the student self-cancel flow.
  const workshopRefundable = event.type === 'workshop' && hoursUntilStart >= WORKSHOP_REFUND_MIN_HOURS;
  let refundInitiated = false;
  if ((event.type === 'meetup' || workshopRefundable) && reg.payment?.status === 'captured' && reg.payment.razorpayPaymentId) {
    try {
      const { issueRazorpayRefund } = await import('../payments/service.js');
      const { updateEventPaymentRefunded } = await import('../payments/repo.js');
      const refundId = await issueRazorpayRefund(reg.payment.razorpayPaymentId, reg.payment.amountPaise);
      await updateEventPaymentRefunded(reg.payment.id, refundId, reg.payment.amountPaise);
      refundInitiated = true;
    } catch { /* reconcile worker will retry */ }
  }

  return { cancelled: true, refund_initiated: refundInitiated };
}
