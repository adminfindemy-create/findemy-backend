import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import * as repo from './repo.js';

function serialize(event: any) {
  return {
    id: event.id,
    type: event.type,
    title: event.title,
    category: event.category,
    description: event.description,
    start_at: event.startAt.toISOString(),
    end_at: event.endAt.toISOString(),
    location: event.location,
    lat: event.lat,
    lng: event.lng,
    capacity: event.capacity,
    enrolled_count: event.enrolledCount,
    price_paise: event.pricePaise ?? 0,
    organizer_name: event.organizerName,
    cover_color: event.coverColor,
    registration_deadline: event.registrationDeadline?.toISOString() ?? null,
    prize_paise: event.prizePaise ?? null,
    is_spotlight: event.isSpotlight ?? false,
    spots_left: event.capacity != null ? Math.max(event.capacity - event.enrolledCount, 0) : null,
    divisions: event.divisions ?? [],
    created_at: event.createdAt.toISOString(),
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
  const registration = await repo.findRegistration(eventId, userId);
  return { registered: !!registration, status: registration?.status ?? null, registration_id: registration?.id ?? null };
}

// Lazily constructed & cached — avoids paying the `import('razorpay')` cost on every
// request, and avoids constructing a client with empty keys when running mocked/unconfigured.
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

  const existingRegistration = await repo.findRegistration(eventId, userId);
  if (existingRegistration) {
    if (existingRegistration.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already registered');
    if (existingRegistration.status === 'pending' && (event as any).pricePaise > 0) {
      return { registration_id: existingRegistration.id, requires_payment: true, amount_paise: (event as any).pricePaise };
    }
  }

  const registration = existingRegistration ?? await repo.createRegistration(eventId, userId);

  if ((event as any).pricePaise === 0) {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.$transaction(async (tx: any) => {
      await repo.confirmRegistration(registration.id, tx);
      await repo.incrementEnrolledCount(eventId, tx);
    });
    return { registration_id: registration.id, requires_payment: false, amount_paise: 0 };
  }

  return { registration_id: registration.id, requires_payment: true, amount_paise: (event as any).pricePaise };
}

export async function createEventPaymentOrder(registrationId: string, userId: string) {
  const registration = await repo.findRegistrationById(registrationId);
  if (!registration) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (registration.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (registration.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already confirmed');

  const amountPaise = registration.event.pricePaise;
  const idempotencyKey = crypto.createHash('sha256').update(`ev:${registrationId}:${amountPaise}`).digest('hex');

  const existingPayment = await repo.findEventPaymentByIdempotencyKey(idempotencyKey);
  if (existingPayment) {
    return { razorpay_order_id: existingPayment.razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: existingPayment.amountPaise, currency: existingPayment.currency };
  }

  let razorpayOrderId = `order_ev_${newId().slice(0, 12)}`;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const razorpayClient = await getRazorpay();
    const order = await razorpayClient.orders.create({
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
  const registration = await repo.findRegistrationById(registrationId);
  if (!registration) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (registration.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (registration.status === 'cancelled') throw new AppError('VALIDATION', 400, 'Already cancelled');
  if (registration.status !== 'confirmed') throw new AppError('VALIDATION', 400, 'Registration not confirmed');

  const event = registration.event;
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
  if (event.type === 'meetup' && registration.payment?.status === 'captured' && registration.payment.razorpayPaymentId) {
    try {
      const { issueRazorpayRefund } = await import('../payments/service.js');
      const { updateEventPaymentRefunded } = await import('../payments/repo.js');
      const refundId = await issueRazorpayRefund(registration.payment.razorpayPaymentId, registration.payment.amountPaise);
      await updateEventPaymentRefunded(registration.payment.id, refundId, registration.payment.amountPaise);
      refundInitiated = true;
    } catch { /* reconcile worker will retry */ }
  }

  return { cancelled: true, refund_initiated: refundInitiated };
}
