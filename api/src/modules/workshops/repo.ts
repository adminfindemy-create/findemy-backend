import type { Category } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { WorkshopScope } from '../../lib/scope.js';

/**
 * What discovery is allowed to show: PUBLISHED (not a draft) and NOT YET OVER.
 *
 * `status` alone was the old filter, and it is not a clock — nothing ever moves a workshop off
 * 'upcoming', so last week's workshop kept appearing. The time half is `endAt`, and it is the
 * END so that a session in progress stays listed for the students attending it.
 */
const discoverable = () => ({ status: 'upcoming', endAt: { gte: new Date() } });

export async function findAll(limit = 50) {
  return prisma.workshop.findMany({
    where: discoverable(),
    include: WORKSHOP_COACHES,
    orderBy: { startAt: 'asc' },
    take: limit,
  });
}

export async function findByAcademy(academyId: string, limit = 20) {
  return prisma.workshop.findMany({
    where: { academyId, ...discoverable() },
    orderBy: { startAt: 'asc' },
    take: limit,
    include: WORKSHOP_COACHES,
  });
}

// The studio-side list. `scope` narrows a TEACHER to the workshops they are conducting —
// without it they saw the whole branch's list, pricing included.
export async function findByStudio(scope: WorkshopScope) {
  return prisma.workshop.findMany({
    where: scope,
    orderBy: { startAt: 'desc' },
    include: WORKSHOP_COACHES,
  });
}

/**
 * Who is conducting it — assigned teachers, plus the brand OWNER as the fallback host.
 *
 * A workshop with no assigned teacher is one the owner is running themselves, and students
 * still need a name against it. The owner is an `AcademyAccount`, not a `Coach`, so it cannot
 * be modelled as an assignment; it is resolved here for display. Oldest account wins, matching
 * the tie-break used elsewhere for a group's "primary" account.
 */
export const WORKSHOP_COACHES = {
  coaches: { include: { coach: { select: { id: true, name: true } } } },
  academy: {
    select: {
      id: true,
      name: true,
      group: {
        select: {
          accounts: { select: { ownerName: true }, orderBy: { createdAt: 'asc' }, take: 1 },
        },
      },
    },
  },
} as const;

export async function findByIdInScope(id: string, scope: WorkshopScope) {
  return prisma.workshop.findFirst({ where: { ...scope, id }, include: WORKSHOP_COACHES });
}

/**
 * Replace a workshop's co-hosts wholesale. Simpler than diffing, and it cannot leave a stale
 * assignment behind — the failure that would actually matter, since a stale one keeps showing
 * the workshop to a teacher who is no longer on it.
 */
export async function setWorkshopCoaches(workshopId: string, coachIds: string[]) {
  await prisma.$transaction([
    prisma.workshopCoach.deleteMany({ where: { workshopId } }),
    prisma.workshopCoach.createMany({
      data: coachIds.map((coachId) => ({ workshopId, coachId })),
      skipDuplicates: true,
    }),
  ]);
}

/** Validates that every id is a coach of this brand, so a cross-brand id cannot be attached. */
export async function coachIdsInGroup(groupId: string, ids: string[]) {
  const rows = await prisma.coach.findMany({
    where: { groupId, id: { in: ids } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function findById(id: string) {
  return prisma.workshop.findUnique({ where: { id }, include: WORKSHOP_COACHES });
}

// S: academy-facing roster of everyone who registered for a workshop (scoped to the
// owning academy). Includes the registrant's contact fields + their payment row.
export async function getRegistrationsForAcademy(academyId: string, workshopId: string) {
  return (prisma as any).workshopRegistration.findMany({
    where: { workshopId, workshop: { academyId } },
    include: {
      user: { select: { id: true, name: true, phone: true, age: true } },
      payment: { select: { status: true, amountPaise: true, capturedAt: true } },
      attendees: { orderBy: { position: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findRegistration(workshopId: string, userId: string) {
  return (prisma as any).workshopRegistration.findUnique({
    where: { workshopId_userId: { workshopId, userId } },
    include: { payment: true, attendees: { orderBy: { position: 'asc' } } },
  });
}

/**
 * Write the account's booking for a workshop as `pending` with these tickets: a new row, or the
 * existing one (an unpaid or cancelled booking) with its tickets replaced.
 */
export async function savePendingRegistration(
  workshopId: string,
  userId: string,
  attendees: { name: string; position: number }[],
  existingId?: string,
) {
  const { newId } = await import('../../lib/id.js');
  return prisma.$transaction(async (tx) => {
    const reg = existingId
      ? await tx.workshopRegistration.update({
          where: { id: existingId },
          data: { status: 'pending', cancelledAt: null, quantity: attendees.length },
        })
      : await tx.workshopRegistration.create({
          data: { id: newId(), workshopId, userId, status: 'pending', quantity: attendees.length },
        });
    await tx.workshopAttendee.deleteMany({ where: { registrationId: reg.id } });
    await tx.workshopAttendee.createMany({
      data: attendees.map((a) => ({ id: newId(), registrationId: reg.id, name: a.name, position: a.position })),
    });
    return reg;
  });
}

/** Confirm a booking. `quantity` pins the ticket count to what was actually paid for. */
export async function confirmRegistration(id: string, tx?: any, quantity?: number) {
  const client = tx ?? prisma;
  return (client as any).workshopRegistration.update({
    where: { id },
    data: { status: 'confirmed', ...(quantity ? { quantity } : {}) },
  });
}

export async function incrementRegisteredCount(id: string, tx?: any, by = 1) {
  const client = tx ?? prisma;
  return client.workshop.update({
    where: { id },
    data: { registeredCount: { increment: by } },
  });
}

export async function createWorkshopPayment(data: {
  id: string;
  registrationId: string;
  amountPaise: number;
  quantity: number;
  currency: string;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return (prisma as any).workshopPayment.create({ data });
}

export async function findWorkshopPaymentByRegistration(registrationId: string) {
  return prisma.workshopPayment.findUnique({ where: { registrationId } });
}

/** Point an unpaid payment row at a fresh order, after the ticket count (and so the amount) changed. */
export async function replaceWorkshopPaymentOrder(id: string, data: {
  amountPaise: number;
  quantity: number;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return prisma.workshopPayment.update({ where: { id }, data: { ...data, status: 'initiated' } });
}

export async function findWorkshopPaymentByOrderId(razorpayOrderId: string) {
  return (prisma as any).workshopPayment.findUnique({
    where: { razorpayOrderId },
    include: {
      registration: { include: { workshop: true, user: true } },
    },
  });
}

export async function updateWorkshopPaymentCaptured(id: string, razorpayPaymentId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).workshopPayment.update({
    where: { id },
    data: { status: 'captured', razorpayPaymentId, capturedAt: new Date() },
  });
}

export async function updateWorkshopPaymentFailed(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).workshopPayment.update({
    where: { id },
    data: { status: 'failed' },
  });
}

/**
 * The ONE place `endAt` is derived. Every write goes through here, so the column cannot drift
 * from the start time and duration it is supposed to describe.
 */
function endAtFrom(startAt: Date, durationMin: number): Date {
  return new Date(startAt.getTime() + durationMin * 60_000);
}

export async function create(academyId: string, data: {
  type: 'online' | 'offline';
  title: string;
  category: Category;
  description: string;
  startAt: Date;
  durationMin: number;
  location?: string;
  capacity: number;
  pricePaise: number;
  status?: string;
  coverImageUrl?: string | null;
}) {
  return prisma.workshop.create({
    data: { academyId, ...data, endAt: endAtFrom(data.startAt, data.durationMin) },
  });
}

export async function update(id: string, data: Partial<{
  type: 'online' | 'offline';
  title: string;
  category: Category;
  description: string;
  startAt: Date;
  durationMin: number;
  location?: string;
  capacity: number;
  pricePaise: number;
  status: string;
  coverImageUrl: string | null;
}>) {
  // An edit may move the start, change the duration, or neither — and changing EITHER moves the
  // end. Read the row and recompute inside one transaction so a concurrent edit cannot leave
  // `endAt` describing a start time that was overwritten in between.
  return prisma.$transaction(async (tx) => {
    const current = await tx.workshop.findUniqueOrThrow({
      where: { id },
      select: { startAt: true, durationMin: true },
    });
    const startAt = data.startAt ?? current.startAt;
    const durationMin = data.durationMin ?? current.durationMin;
    return tx.workshop.update({
      where: { id },
      data: { ...data, endAt: endAtFrom(startAt, durationMin) },
    });
  });
}

export async function remove(id: string) {
  return prisma.workshop.delete({ where: { id } });
}

export async function findRegistrationById(id: string) {
  return (prisma as any).workshopRegistration.findUnique({
    where: { id },
    include: { workshop: true, payment: true, attendees: { orderBy: { position: 'asc' } } },
  });
}

export async function cancelRegistration(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).workshopRegistration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}

export async function decrementRegisteredCount(workshopId: string, tx?: any, by = 1) {
  const client = tx ?? prisma;
  return client.workshop.update({
    where: { id: workshopId },
    data: { registeredCount: { decrement: by } },
  });
}
