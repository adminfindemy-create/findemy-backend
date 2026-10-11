import crypto from 'node:crypto';
import type { Category } from '@prisma/client';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import * as repo from './repo.js';
import type { WorkshopScope } from '../../lib/scope.js';
import { MAX_TICKETS, resolveTicketAttendees, serializeAttendee, type AttendeeInput } from '../../lib/tickets.js';

// serialize only reads scalar workshop fields (never the `academy` relation),
// so its param is the base workshop shape (without `academy`). Queries that DO
// include `academy` produce a superset and remain assignable here.
type WorkshopRow = Awaited<ReturnType<typeof repo.findByAcademy>>[number];

function serialize(w: WorkshopRow | null) {
  if (!w) return null;
  const coaches = (w.coaches ?? []).map((c) => ({ id: c.coach.id, name: c.coach.name }));
  // Who students see it billed to. Assigned teachers if there are any, otherwise the brand
  // owner — a workshop the academy runs itself still needs a name against it.
  const ownerName = w.academy?.group?.accounts?.[0]?.ownerName ?? null;
  const hosts = coaches.length ? coaches.map((c) => c.name) : ownerName ? [ownerName] : [];
  return {
    id: w.id,
    academy_id: w.academyId,
    type: w.type,
    title: w.title,
    category: w.category,
    description: w.description,
    start_at: w.startAt.toISOString(),
    duration_min: w.durationMin,
    end_at: w.endAt.toISOString(),
    location: w.location ?? undefined,
    capacity: w.capacity,
    registered_count: w.registeredCount,
    price_paise: w.pricePaise,
    status: w.status,
    cover_image_url: w.coverImageUrl ?? undefined,
    // Assigned teachers. Empty means the academy runs it itself — see `hosts`.
    coaches,
    // Display names, owner-fallback applied. This is what a student reads.
    hosts,
    live: w.status === 'upcoming' &&
      Date.now() >= w.startAt.getTime() &&
      Date.now() <= w.endAt.getTime(),
    /** Derived, so a detail screen opened from a deep link or a booking can say "this is over". */
    has_ended: w.endAt.getTime() <= Date.now(),
    created_at: w.createdAt.toISOString(),
  };
}

function serializeGlobal(w: WorkshopRow) {
  return {
    ...serialize(w),
    academy_name: w.academy.name,
  };
}

export async function listAll() {
  const workshops = await repo.findAll();
  return { items: workshops.map(serializeGlobal) };
}

export async function listForAcademy(academyId: string) {
  const workshops = await repo.findByAcademy(academyId);
  return { items: workshops.map(serialize) };
}

export async function listForStudio(scope: WorkshopScope) {
  const workshops = await repo.findByStudio(scope);
  return { items: workshops.map(serialize) };
}

export async function createWorkshop(academyId: string, body: {
  type: 'online' | 'offline';
  title: string;
  category: Category;
  description: string;
  start_at: string;
  duration_min: number;
  location?: string;
  capacity: number;
  price_paise: number;
  status?: 'draft' | 'upcoming';
  cover_image_url?: string | null;
  coach_ids?: string[];
}, groupId?: string) {
  const w = await repo.create(academyId, {
    type: body.type,
    title: body.title,
    category: body.category,
    description: body.description,
    startAt: new Date(body.start_at),
    durationMin: body.duration_min,
    location: body.location,
    capacity: body.capacity,
    pricePaise: body.price_paise,
    status: body.status ?? 'upcoming',
    coverImageUrl: body.cover_image_url ?? null,
  });
  await assignCoaches(w.id, body.coach_ids, groupId);
  return { workshop: serialize(await repo.findById(w.id)) };
}

/**
 * Attach the teachers conducting a workshop, rejecting any id that is not a coach of this
 * brand. An EMPTY list is meaningful and allowed: the academy is running it itself, and then no
 * teacher sees it in their list.
 */
async function assignCoaches(workshopId: string, coachIds: string[] | undefined, groupId?: string) {
  if (!coachIds) return;
  const valid = groupId ? await repo.coachIdsInGroup(groupId, coachIds) : coachIds;
  if (valid.length !== new Set(coachIds).size) {
    throw new AppError('VALIDATION', 400, 'One or more teachers are not part of your academy');
  }
  await repo.setWorkshopCoaches(workshopId, valid);
}

export async function updateWorkshop(id: string, academyId: string, body: Partial<{
  type: 'online' | 'offline';
  title: string;
  category: Category;
  description: string;
  start_at: string;
  duration_min: number;
  location?: string;
  capacity: number;
  price_paise: number;
  status?: 'draft' | 'upcoming';
  cover_image_url?: string | null;
  coach_ids: string[];
}>, groupId?: string) {
  const existing = await repo.findById(id);
  if (!existing) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (existing.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your workshop');

  const w = await repo.update(id, {
    type: body.type,
    title: body.title,
    category: body.category,
    description: body.description,
    startAt: body.start_at ? new Date(body.start_at) : undefined,
    durationMin: body.duration_min,
    location: body.location,
    capacity: body.capacity,
    pricePaise: body.price_paise,
    status: body.status,
    coverImageUrl: body.cover_image_url,
  });
  await assignCoaches(id, body.coach_ids, groupId);
  // Re-read rather than serialize the bare update result: only `findById` carries the coaches
  // and the owner fallback that `serialize` needs.
  void w;
  return { workshop: serialize(await repo.findById(id)) };
}

export async function getWorkshop(id: string) {
  const w = await repo.findById(id);
  if (!w) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  return { workshop: serializeGlobal(w) };
}

// S: academy views who booked one of its workshops. 404s if the workshop isn't theirs — and,
// for a TEACHER, if they are not one of its co-hosts. Knowing who is coming to your own
// workshop is the point; seeing another teacher's roster is not.
export async function getWorkshopRegistrations(scope: WorkshopScope, workshopId: string) {
  const w = await repo.findByIdInScope(workshopId, scope);
  if (!w) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  const rows = await repo.getRegistrationsForAcademy(scope.academyId, workshopId);
  return {
    workshop: {
      id: w.id,
      title: w.title,
      capacity: w.capacity,
      registered_count: w.registeredCount,
      price_paise: w.pricePaise,
    },
    registrations: rows.map((r: any) => ({
      id: r.id,
      status: r.status as 'pending' | 'confirmed' | 'cancelled',
      registered_at: r.createdAt.toISOString(),
      payment_status: r.payment?.status ?? null,
      amount_paise: r.payment?.amountPaise ?? 0,
      quantity: r.quantity ?? 1,
      attendees: (r.attendees ?? []).map(serializeAttendee),
      user: {
        id: r.user.id,
        name: r.user.name,
        phone: r.user.phone ?? null,
        age: r.user.age ?? null,
      },
    })),
  };
}

/**
 * A HOST token for the workshop's live room, for the teacher conducting it.
 *
 * The student path (`/rooms/workshop/:id/token`) requires a registration, so a teacher could
 * not join their own workshop at all — there was no academy-side entry point. Mirrors
 * `startLiveClass` for batches: same room id (the workshop's own id), host role.
 */
export async function getWorkshopHostToken(scope: WorkshopScope, workshopId: string, actorId: string) {
  const w = await repo.findByIdInScope(workshopId, scope);
  if (!w) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (w.type !== 'online') {
    throw new AppError('NOT_ONLINE', 400, 'This workshop is in-studio — there is nothing to join');
  }
  const { generateHmsToken } = await import('../rooms/service.js');
  // The room IS the workshop id, matching what the student side joins.
  const token = await generateHmsToken(w.id, actorId, 'host');
  return { token, room_id: w.id, room_name: w.title };
}

export async function getRegistrationStatus(workshopId: string, userId: string) {
  const reg = await repo.findRegistration(workshopId, userId);
  return {
    registered: !!reg,
    status: reg?.status ?? null,
    registration_id: reg?.id ?? null,
    quantity: reg?.quantity ?? null,
    attendees: (reg?.attendees ?? []).map(serializeAttendee),
  };
}

/** Most tickets one booking may hold for this workshop: one online, else up to MAX_TICKETS. */
function ticketLimit(w: { type: string }) {
  return w.type === 'online' ? 1 : MAX_TICKETS;
}

export async function registerForWorkshop(workshopId: string, userId: string, attendeeInput?: AttendeeInput[]) {
  const w = await repo.findById(workshopId);
  if (!w) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (w.status !== 'upcoming') throw new AppError('VALIDATION', 400, 'Workshop is not open for registration');
  // The list no longer offers a finished workshop, but a deep link, a stale screen or a saved
  // item still reaches this endpoint — and taking money for a workshop that already happened is
  // the failure that actually costs someone.
  if (w.endAt <= new Date()) throw new AppError('VALIDATION', 400, 'This workshop has already taken place');

  const attendees = await resolveTicketAttendees(userId, attendeeInput, ticketLimit(w));
  const quantity = attendees.length;
  const seatsLeft = Math.max(w.capacity - w.registeredCount, 0);
  if (seatsLeft === 0) throw new AppError('VALIDATION', 400, 'Workshop is full');
  if (quantity > seatsLeft) {
    throw new AppError('NOT_ENOUGH_SEATS', 400, `Only ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left`);
  }

  const existing = await repo.findRegistration(workshopId, userId);
  if (existing?.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already registered');
  // A cancelled booking that was paid keeps its payment (and refund) record, and a booking has
  // room for one payment — so it can't be paid for a second time.
  if (existing?.status === 'cancelled' && existing.payment?.status === 'captured') {
    throw new AppError('REBOOK_NOT_SUPPORTED', 409, 'You cancelled a paid booking for this workshop, so it can’t be booked again');
  }

  const reg = await repo.savePendingRegistration(workshopId, userId, attendees, existing?.id);
  const amountPaise = w.pricePaise * quantity;

  // Free workshop — confirm immediately
  if (w.pricePaise === 0) {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.$transaction(async (tx: any) => {
      await repo.confirmRegistration(reg.id, tx, quantity);
      await repo.incrementRegisteredCount(workshopId, tx, quantity);
    });
    return { registration_id: reg.id, requires_payment: false, amount_paise: 0, quantity };
  }

  return { registration_id: reg.id, requires_payment: true, amount_paise: amountPaise, quantity };
}

let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID || '', key_secret: env.RAZORPAY_KEY_SECRET || '' });
  return razorpayInstance;
}

export async function createWorkshopPaymentOrder(registrationId: string, userId: string) {
  const reg = await repo.findRegistrationById(registrationId);
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (reg.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already confirmed');

  const quantity: number = reg.quantity ?? 1;
  const amountPaise = reg.workshop.pricePaise * quantity;
  const idempotencyKey = crypto.createHash('sha256').update(`ws:${registrationId}:${amountPaise}`).digest('hex');
  const key = env.RAZORPAY_KEY_ID || 'rzp_test_xxx';

  // One payment row per booking. Same amount → reuse its order; a changed ticket count → a fresh
  // order on the same row (only while it is unpaid).
  const existing = await repo.findWorkshopPaymentByRegistration(registrationId);
  if (existing && existing.idempotencyKey === idempotencyKey) {
    return { razorpay_order_id: existing.razorpayOrderId, razorpay_key: key, amount_paise: existing.amountPaise, currency: existing.currency, quantity: existing.quantity };
  }
  if (existing && existing.status === 'captured') {
    throw new AppError('VALIDATION', 400, 'This booking is already paid');
  }

  let razorpayOrderId = `order_ws_${newId().slice(0, 12)}`;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const rp = await getRazorpay();
    const order = await rp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: registrationId,
      notes: { workshop_registration_id: registrationId, tickets: String(quantity) },
    });
    razorpayOrderId = order.id;
  }

  if (existing) {
    await repo.replaceWorkshopPaymentOrder(existing.id, { amountPaise, quantity, razorpayOrderId, idempotencyKey });
  } else {
    await repo.createWorkshopPayment({ id: newId(), registrationId, amountPaise, quantity, currency: 'INR', razorpayOrderId, idempotencyKey });
  }

  return { razorpay_order_id: razorpayOrderId, razorpay_key: key, amount_paise: amountPaise, currency: 'INR', quantity };
}

export async function cancelWorkshopRegistration(
  registrationId: string,
  userId: string,
  _opts: { acknowledgeNoRefund?: boolean; reason?: string } = {},
) {
  const { prisma: db } = await import('../../lib/prisma.js');
  const reg = await repo.findRegistrationById(registrationId);
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (reg.status === 'cancelled') throw new AppError('VALIDATION', 400, 'Already cancelled');
  if (reg.status !== 'confirmed') throw new AppError('VALIDATION', 400, 'Registration not confirmed');

  // Workshops are refundable if cancelled at least WORKSHOP_REFUND_MIN_HOURS before start; within
  // that window they are non-refundable (policy 2026-07-09). A captured payment is refunded in full.
  const { WORKSHOP_REFUND_MIN_HOURS } = await import('../../config.js');
  const hoursUntilStart = (reg.workshop.startAt.getTime() - Date.now()) / (1000 * 60 * 60);
  const refundEligible = hoursUntilStart >= WORKSHOP_REFUND_MIN_HOURS;

  await db.$transaction(async (tx: any) => {
    // The whole booking goes: every ticket in it is released.
    await repo.cancelRegistration(registrationId, tx);
    await repo.decrementRegisteredCount(reg.workshopId, tx, reg.quantity ?? 1);
  });

  let refundInitiated = false;
  let refundAmountPaise = 0;
  if (refundEligible && reg.payment?.status === 'captured' && reg.payment.razorpayPaymentId) {
    try {
      const { issueRazorpayRefund } = await import('../payments/service.js');
      const { updateWorkshopPaymentRefunded, reverseCommission } = await import('../payments/repo.js');
      const refundId = await issueRazorpayRefund(reg.payment.razorpayPaymentId, reg.payment.amountPaise);
      await updateWorkshopPaymentRefunded(reg.payment.id, refundId, reg.payment.amountPaise);
      await reverseCommission('workshop', reg.payment.id, reg.payment.amountPaise);
      refundInitiated = true;
      refundAmountPaise = reg.payment.amountPaise;
    } catch {
      // The refund-reconcile worker retries a failed Razorpay call.
    }
  }

  return {
    cancelled: true,
    refund_eligible: refundEligible,
    refund_initiated: refundInitiated,
    refund_amount_paise: refundAmountPaise,
  };
}

export async function deleteWorkshop(id: string, academyId: string) {
  const existing = await repo.findById(id);
  if (!existing) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (existing.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your workshop');
  await repo.remove(id);
  return {};
}
