import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import * as repo from './repo.js';

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
    lat: e.lat,
    lng: e.lng,
    capacity: e.capacity,
    enrolled_count: e.enrolledCount,
    price_paise: e.pricePaise ?? 0,
    organizer_name: e.organizerName,
    cover_color: e.coverColor,
    registration_deadline: e.registrationDeadline?.toISOString() ?? null,
    prize_paise: e.prizePaise ?? null,
    is_spotlight: e.isSpotlight ?? false,
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
  return { registered: !!reg, status: reg?.status ?? null, registration_id: reg?.id ?? null };
}

let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID || '', key_secret: env.RAZORPAY_KEY_SECRET || '' });
  return razorpayInstance;
}

export async function registerForEvent(eventId: string, userId: string) {
  const event = await repo.findEventById(eventId);
  if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');
  if (event.capacity !== null && (event as any).enrolledCount >= event.capacity) {
    throw new AppError('VALIDATION', 400, 'Event is full');
  }

  const deadline = (event as any).registrationDeadline;
  if (deadline && new Date() > deadline) {
    throw new AppError('REGISTRATION_CLOSED', 400, 'Registration deadline has passed');
  }

  const existing = await repo.findRegistration(eventId, userId);
  if (existing) {
    if (existing.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already registered');
    if (existing.status === 'pending' && (event as any).pricePaise > 0) {
      return { registration_id: existing.id, requires_payment: true, amount_paise: (event as any).pricePaise };
    }
  }

  const reg = existing ?? await repo.createRegistration(eventId, userId);

  if ((event as any).pricePaise === 0) {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.$transaction(async (tx: any) => {
      await repo.confirmRegistration(reg.id, tx);
      await repo.incrementEnrolledCount(eventId, tx);
    });
    return { registration_id: reg.id, requires_payment: false, amount_paise: 0 };
  }

  return { registration_id: reg.id, requires_payment: true, amount_paise: (event as any).pricePaise };
}

export async function createEventPaymentOrder(registrationId: string, userId: string) {
  const reg = await repo.findRegistrationById(registrationId);
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (reg.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already confirmed');

  const amountPaise = reg.event.pricePaise;
  const idempotencyKey = crypto.createHash('sha256').update(`ev:${registrationId}:${amountPaise}`).digest('hex');

  const existing = await repo.findEventPaymentByIdempotencyKey(idempotencyKey);
  if (existing) {
    return { razorpay_order_id: existing.razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: existing.amountPaise, currency: existing.currency };
  }

  let razorpayOrderId = `order_ev_${newId().slice(0, 12)}`;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const rp = await getRazorpay();
    const order = await rp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: registrationId,
      notes: { event_registration_id: registrationId, payment_type: 'event' },
    });
    razorpayOrderId = order.id;
  }

  await repo.createEventPayment({ id: newId(), registrationId, amountPaise, currency: 'INR', razorpayOrderId, idempotencyKey });

  return { razorpay_order_id: razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: amountPaise, currency: 'INR' };
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

  if (event.type === 'competition' || event.type === 'talent_hunt') {
    // Non-refundable; only cancellable before registration deadline
    const cutoff = deadline ?? new Date(event.startAt.getTime() - 48 * 60 * 60 * 1000);
    if (now > cutoff.getTime()) {
      throw new AppError('CANCELLATION_WINDOW_CLOSED', 400, 'Registration deadline has passed — cancellation not allowed');
    }
  } else {
    // meetup: 2 hours before event start
    const cutoff = new Date(event.startAt.getTime() - 2 * 60 * 60 * 1000);
    if (now > cutoff.getTime()) {
      throw new AppError('CANCELLATION_WINDOW_CLOSED', 400, 'Cannot cancel within 2 hours of the event');
    }
  }

  const { prisma } = await import('../../lib/prisma.js');
  await prisma.$transaction(async (tx: any) => {
    await repo.cancelRegistration(registrationId, tx);
    await repo.decrementEnrolledCount(event.id, tx);
  });

  // Refund for meetups only (competitions are non-refundable)
  let refundInitiated = false;
  if (event.type === 'meetup' && reg.payment?.status === 'captured' && reg.payment.razorpayPaymentId) {
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
