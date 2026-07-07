import { prisma } from '../../lib/prisma.js';

export async function findEvents(type?: string, limit = 20) {
  const where: Record<string, unknown> = {};
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
    include: { payment: true },
  });
}

export async function findRegistrationById(id: string) {
  return (prisma as any).eventRegistration.findUnique({
    where: { id },
    include: { event: true, payment: true },
  });
}

export async function createRegistration(eventId: string, userId: string) {
  const { newId } = await import('../../lib/id.js');
  return (prisma as any).eventRegistration.create({
    data: { id: newId(), eventId, userId, status: 'pending' },
  });
}

export async function confirmRegistration(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).eventRegistration.update({
    where: { id },
    data: { status: 'confirmed' },
  });
}

export async function cancelRegistration(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).eventRegistration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}

export async function incrementEnrolledCount(eventId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.event.update({
    where: { id: eventId },
    data: { enrolledCount: { increment: 1 } },
  });
}

export async function decrementEnrolledCount(eventId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.event.update({
    where: { id: eventId },
    data: { enrolledCount: { decrement: 1 } },
  });
}

export async function createEventPayment(data: {
  id: string;
  registrationId: string;
  amountPaise: number;
  currency: string;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return (prisma as any).eventPayment.create({ data });
}

export async function findEventPaymentByIdempotencyKey(idempotencyKey: string) {
  return (prisma as any).eventPayment.findUnique({ where: { idempotencyKey } });
}
