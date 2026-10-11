import { prisma } from '../../lib/prisma.js';

export async function findEvents(type?: string, limit = 20) {
  // Discovery shows only scheduled events; cancelled ones are hidden (Ops Console gate).
  //
  // `endAt >= now` for the same reason workshops filter on their end time: `status` is an
  // editorial state, not a clock, so without this a finished event kept sitting in the feed —
  // and the two feeds are merged into ONE list in the app (`mergeItems`), so a rule that held
  // for only one of them would show as an inconsistency on a single screen. Filtering on the
  // END keeps a multi-day festival listed while it is running.
  const where: Record<string, unknown> = { status: 'scheduled', endAt: { gte: new Date() } };
  if (type) where.type = type;
  return prisma.event.findMany({
    where,
    orderBy: { startAt: 'asc' },
    take: limit,
  });
}

export async function findEventById(id: string) {
  return prisma.event.findUnique({ where: { id } });
}

export async function findRegistration(eventId: string, userId: string) {
  return (prisma as any).eventRegistration.findUnique({
    where: { eventId_userId: { eventId, userId } },
    include: { payment: true, attendees: { orderBy: { position: 'asc' } } },
  });
}

export async function findRegistrationById(id: string) {
  return (prisma as any).eventRegistration.findUnique({
    where: { id },
    include: { event: true, payment: true, attendees: { orderBy: { position: 'asc' } } },
  });
}

/**
 * Write the account's booking for an event as `pending` with these tickets / participants: a new
 * row, or the existing one (unpaid or cancelled) with its attendees replaced.
 */
export async function savePendingRegistration(
  eventId: string,
  userId: string,
  attendees: { name: string; position: number; learnerId?: string | null }[],
  existingId?: string,
) {
  const { newId } = await import('../../lib/id.js');
  return prisma.$transaction(async (tx) => {
    const reg = existingId
      ? await tx.eventRegistration.update({
          where: { id: existingId },
          data: { status: 'pending', cancelledAt: null, quantity: attendees.length },
        })
      : await tx.eventRegistration.create({
          data: { id: newId(), eventId, userId, status: 'pending', quantity: attendees.length },
        });
    await tx.eventAttendee.deleteMany({ where: { registrationId: reg.id } });
    await tx.eventAttendee.createMany({
      data: attendees.map((a) => ({
        id: newId(),
        registrationId: reg.id,
        name: a.name,
        position: a.position,
        learnerId: a.learnerId ?? null,
      })),
    });
    return reg;
  });
}

export async function confirmRegistration(id: string, tx?: any, quantity?: number) {
  const client = tx ?? prisma;
  return (client as any).eventRegistration.update({
    where: { id },
    data: { status: 'confirmed', ...(quantity ? { quantity } : {}) },
  });
}

export async function cancelRegistration(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).eventRegistration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}

export async function incrementEnrolledCount(eventId: string, tx?: any, by = 1) {
  const client = tx ?? prisma;
  return client.event.update({
    where: { id: eventId },
    data: { enrolledCount: { increment: by } },
  });
}

export async function decrementEnrolledCount(eventId: string, tx?: any, by = 1) {
  const client = tx ?? prisma;
  return client.event.update({
    where: { id: eventId },
    data: { enrolledCount: { decrement: by } },
  });
}

export async function createEventPayment(data: {
  id: string;
  registrationId: string;
  amountPaise: number;
  quantity: number;
  currency: string;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return (prisma as any).eventPayment.create({ data });
}

export async function findEventPaymentByRegistration(registrationId: string) {
  return prisma.eventPayment.findUnique({ where: { registrationId } });
}

/** Point an unpaid payment row at a fresh order, after the ticket count (and so the amount) changed. */
export async function replaceEventPaymentOrder(id: string, data: {
  amountPaise: number;
  quantity: number;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return prisma.eventPayment.update({ where: { id }, data: { ...data, status: 'initiated' } });
}

export async function findEventPaymentByIdempotencyKey(idempotencyKey: string) {
  return (prisma as any).eventPayment.findUnique({ where: { idempotencyKey } });
}
