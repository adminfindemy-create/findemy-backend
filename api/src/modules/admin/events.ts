import type { Category, EventType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { WORKSHOP_REFUND_MIN_HOURS } from '../../config.js';
import { newId } from '../../lib/id.js';
import { sanitizeRichText } from '../../lib/sanitize.js';
import { issueRazorpayRefund } from '../payments/service.js';
import { updateEventPaymentRefunded } from '../payments/repo.js';
import { writeAudit } from './audit.js';

// Events are PLATFORM-owned (no academyId) → no commission, no academy recovery. Admin refunds
// are platform-borne: issue the Razorpay refund + mark the event payment; nothing to reverse.

export type EventInput = {
  type: EventType;
  title: string;
  category: Category[];
  description: string;
  startAt: string;
  endAt: string;
  location: string;
  lat?: number | null;
  lng?: number | null;
  capacity?: number | null;
  pricePaise: number;
  organizerName: string;
  coverColor: string;
  coverImageUrl?: string | null;
  galleryImageUrls?: string[];
  registrationOpensAt?: string | null;
  registrationDeadline?: string | null;
  prizePaise?: number | null;
  isSpotlight?: boolean;
  divisions?: string[];
};

function serialize(e: any) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    category: e.category, // Category[]
    description: e.description,
    start_at: e.startAt.toISOString(),
    end_at: e.endAt.toISOString(),
    location: e.location,
    lat: e.lat,
    lng: e.lng,
    capacity: e.capacity,
    enrolled_count: e.enrolledCount,
    price_paise: e.pricePaise,
    organizer_name: e.organizerName,
    cover_color: e.coverColor,
    cover_image_url: e.coverImageUrl ?? null,
    gallery_image_urls: e.galleryImageUrls ?? [],
    registration_opens_at: e.registrationOpensAt?.toISOString() ?? null,
    registration_deadline: e.registrationDeadline?.toISOString() ?? null,
    prize_paise: e.prizePaise ?? null,
    is_spotlight: e.isSpotlight,
    divisions: e.divisions ?? [],
    status: e.status,
    cancelled_reason: e.cancelledReason ?? null,
    created_at: e.createdAt.toISOString(),
  };
}

function toData(input: EventInput) {
  return {
    type: input.type,
    title: input.title,
    category: input.category,
    description: sanitizeRichText(input.description),
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
    location: input.location,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    capacity: input.capacity ?? null,
    pricePaise: input.pricePaise,
    organizerName: input.organizerName,
    coverColor: input.coverColor,
    coverImageUrl: input.coverImageUrl ?? null,
    galleryImageUrls: input.galleryImageUrls ?? [],
    registrationOpensAt: input.registrationOpensAt ? new Date(input.registrationOpensAt) : null,
    registrationDeadline: input.registrationDeadline ? new Date(input.registrationDeadline) : null,
    prizePaise: input.prizePaise ?? null,
    isSpotlight: input.isSpotlight ?? false,
    divisions: input.divisions ?? [],
  };
}

// ---------- Read ----------

export async function listEvents(status?: 'scheduled' | 'cancelled') {
  const events = await prisma.event.findMany({
    where: status ? { status } : undefined,
    orderBy: { startAt: 'asc' },
    include: { _count: { select: { registrations: { where: { status: 'confirmed' } } } } },
  });
  return {
    events: events.map((e) => ({ ...serialize(e), confirmed_registrations: e._count.registrations })),
  };
}

export async function getEvent(id: string) {
  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      registrations: {
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, phone: true } },
          payment: true,
          attendees: { orderBy: { position: 'asc' } },
        },
      },
    },
  });
  if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');
  const revenuePaise = event.registrations
    .filter((r) => r.payment?.status === 'captured')
    .reduce((s, r) => s + (r.payment!.amountPaise - (r.payment!.refundAmountPaise ?? 0)), 0);
  return {
    event: serialize(event),
    revenue_paise: revenuePaise,
    registrations: event.registrations.map((r) => ({
      id: r.id,
      status: r.status,
      user: r.user,
      quantity: r.quantity,
      attendees: r.attendees.map((a) => ({ name: a.name, position: a.position, learner_id: a.learnerId })),
      created_at: r.createdAt.toISOString(),
      cancelled_at: r.cancelledAt?.toISOString() ?? null,
      payment: r.payment
        ? {
            id: r.payment.id,
            amount_paise: r.payment.amountPaise,
            status: r.payment.status,
            refund_status: r.payment.refundStatus,
            refund_amount_paise: r.payment.refundAmountPaise ?? 0,
          }
        : null,
    })),
  };
}

// ---------- Write ----------

// #6: authoritative date guard — enforces now <= registrationOpensAt <= registrationDeadline
// <= startAt < endAt. `allowPast` relaxes the no-past-dates rule for updates (so an event that
// has already started can still be managed); the ordering constraints always apply.
function validateEventDates(input: EventInput, opts: { allowPast: boolean }) {
  const start = new Date(input.startAt);
  const end = new Date(input.endAt);
  const opens = input.registrationOpensAt ? new Date(input.registrationOpensAt) : null;
  const deadline = input.registrationDeadline ? new Date(input.registrationDeadline) : null;

  if (end <= start) throw new AppError('BAD_REQUEST', 400, 'End time must be after start time');
  if (!opts.allowPast && start.getTime() < Date.now()) {
    throw new AppError('BAD_REQUEST', 400, 'Start time cannot be in the past');
  }
  if (deadline && deadline > start) {
    throw new AppError('BAD_REQUEST', 400, 'Registration deadline must be on or before the start time');
  }
  if (opens) {
    if (deadline && opens > deadline) {
      throw new AppError('BAD_REQUEST', 400, 'Registration must open on or before the registration deadline');
    }
    if (opens > start) {
      throw new AppError('BAD_REQUEST', 400, 'Registration must open on or before the start time');
    }
  }
}

export async function createEvent(actorId: string, input: EventInput) {
  validateEventDates(input, { allowPast: false });
  const event = await prisma.event.create({ data: { id: newId(), ...toData(input) } });
  await writeAudit({ adminId: actorId, action: 'event.create', targetType: 'Event', targetId: event.id, after: serialize(event) });
  return { event: serialize(event) };
}

export async function updateEvent(actorId: string, id: string, input: EventInput) {
  const before = await prisma.event.findUnique({ where: { id } });
  if (!before) throw new AppError('NOT_FOUND', 404, 'Event not found');
  if (before.status === 'cancelled') throw new AppError('BAD_REQUEST', 400, 'Cannot edit a cancelled event');
  validateEventDates(input, { allowPast: true });
  if (input.capacity != null && input.capacity < before.enrolledCount) {
    throw new AppError('BAD_REQUEST', 400, `Capacity cannot be below current enrolled count (${before.enrolledCount})`);
  }
  const event = await prisma.event.update({ where: { id }, data: toData(input) });
  await writeAudit({ adminId: actorId, action: 'event.update', targetType: 'Event', targetId: id, before: serialize(before), after: serialize(event) });
  return { event: serialize(event) };
}

export async function deleteEvent(actorId: string, id: string) {
  const event = await prisma.event.findUnique({
    where: { id },
    include: { _count: { select: { registrations: { where: { status: 'confirmed' } } } } },
  });
  if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');
  if (event._count.registrations > 0) {
    throw new AppError('CONFLICT', 409, 'Event has confirmed registrations — cancel it (refunds attendees) instead of deleting');
  }
  await prisma.$transaction([
    prisma.eventPayment.deleteMany({ where: { registration: { eventId: id } } }),
    prisma.eventRegistration.deleteMany({ where: { eventId: id } }),
    prisma.event.delete({ where: { id } }),
  ]);
  await writeAudit({ adminId: actorId, action: 'event.delete', targetType: 'Event', targetId: id, before: serialize(event) });
  return { deleted: true };
}

// Issue a full refund for one captured event payment (platform-borne). Best-effort on the
// Razorpay call — the refund-reconcile worker retries failures.
async function refundOne(payment: { id: string; amountPaise: number; razorpayPaymentId: string | null }) {
  if (!payment.razorpayPaymentId) return { refunded: false, refundId: null as string | null };
  try {
    const refundId = await issueRazorpayRefund(payment.razorpayPaymentId, payment.amountPaise);
    await updateEventPaymentRefunded(payment.id, refundId, payment.amountPaise);
    return { refunded: true, refundId };
  } catch {
    return { refunded: false, refundId: null };
  }
}

// Organizer/admin cancellation → cancel the event and FULL-refund every confirmed registration.
export async function cancelEvent(actorId: string, id: string, reason: string) {
  const event = await prisma.event.findUnique({
    where: { id },
    include: { registrations: { where: { status: 'confirmed' }, include: { payment: true } } },
  });
  if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');
  if (event.status === 'cancelled') throw new AppError('BAD_REQUEST', 400, 'Event already cancelled');

  let refunded = 0;
  let refundPaise = 0;
  for (const reg of event.registrations) {
    await prisma.eventRegistration.update({ where: { id: reg.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    if (reg.payment?.status === 'captured' && !reg.payment.refundStatus) {
      const r = await refundOne(reg.payment);
      if (r.refunded) {
        refunded += 1;
        refundPaise += reg.payment.amountPaise;
      }
    }
  }
  await prisma.event.update({ where: { id }, data: { status: 'cancelled', cancelledReason: reason, enrolledCount: 0 } });
  await writeAudit({
    adminId: actorId,
    action: 'event.cancel',
    targetType: 'Event',
    targetId: id,
    extra: { reason, registrations_cancelled: event.registrations.length, refunds_issued: refunded, refund_paise: refundPaise },
  });
  return { cancelled: true, registrations_cancelled: event.registrations.length, refunds_issued: refunded, refund_paise: refundPaise };
}

// Per-registration admin refund. Policy by event type:
//   • competition — refundable only while registration is OPEN (before the deadline / start).
//   • workshop    — refundable only up to WORKSHOP_REFUND_MIN_HOURS (24h) before start.
//   • meetup      — non-refundable.
// `force` bypasses the policy and is recorded in the audit log.
export async function refundRegistration(actorId: string, registrationId: string, force = false) {
  const reg = await prisma.eventRegistration.findUnique({
    where: { id: registrationId },
    include: { event: true, payment: true },
  });
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.status !== 'confirmed') throw new AppError('BAD_REQUEST', 400, 'Registration is not confirmed');
  if (!reg.payment || reg.payment.status !== 'captured') throw new AppError('BAD_REQUEST', 400, 'No captured payment to refund');
  if (reg.payment.refundStatus) throw new AppError('CONFLICT', 409, 'Refund already in progress or done');

  const event = reg.event;
  const now = Date.now();
  let policyBlocked = false;
  let policyReason = '';

  if (event.type === 'meetup') {
    policyBlocked = true;
    policyReason = 'Meetups are non-refundable';
  } else if (event.type === 'workshop') {
    // Workshop events: refundable only up to 24h before start.
    const hoursUntilStart = (event.startAt.getTime() - now) / (1000 * 60 * 60);
    if (hoursUntilStart < WORKSHOP_REFUND_MIN_HOURS) {
      policyBlocked = true;
      policyReason = `Workshop is within ${WORKSHOP_REFUND_MIN_HOURS}h of start — no refund allowed`;
    }
  } else {
    // competition: registration must still be open.
    const cutoff = event.registrationDeadline ?? event.startAt;
    if (now > cutoff.getTime()) {
      policyBlocked = true;
      policyReason = 'Registration has closed — no refund allowed';
    }
  }

  if (policyBlocked && !force) {
    throw new AppError('REFUND_NOT_ALLOWED', 422, `${policyReason}. Pass force to override.`);
  }

  await prisma.eventRegistration.update({ where: { id: registrationId }, data: { status: 'cancelled', cancelledAt: new Date() } });
  // Refunding cancels the whole booking, so all of its places come back.
  await prisma.event.update({ where: { id: event.id }, data: { enrolledCount: { decrement: reg.quantity } } });
  const r = await refundOne(reg.payment);

  await writeAudit({
    adminId: actorId,
    action: 'event.refund',
    targetType: 'EventPayment',
    targetId: reg.payment.id,
    extra: {
      registrationId,
      eventId: event.id,
      eventType: event.type,
      amountPaise: reg.payment.amountPaise,
      overrodePolicy: policyBlocked,
      policyReason: policyBlocked ? policyReason : undefined,
    },
  });

  return { refunded: r.refunded, refund_amount_paise: reg.payment.amountPaise, razorpay_refund_id: r.refundId, overrode_policy: policyBlocked };
}
