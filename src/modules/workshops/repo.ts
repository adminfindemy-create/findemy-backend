import { prisma } from '../../lib/prisma.js';

export async function findAll(limit = 50) {
  return prisma.workshop.findMany({
    where: { status: 'upcoming' },
    include: { academy: { select: { id: true, name: true } } },
    orderBy: { startAt: 'asc' },
    take: limit,
  });
}

export async function findByAcademy(academyId: string, limit = 20) {
  return prisma.workshop.findMany({
    where: { academyId, status: 'upcoming' },
    orderBy: { startAt: 'asc' },
    take: limit,
  });
}

export async function findByStudio(academyId: string) {
  return prisma.workshop.findMany({
    where: { academyId },
    orderBy: { startAt: 'desc' },
  });
}

export async function findById(id: string) {
  return prisma.workshop.findUnique({
    where: { id },
    include: { academy: { select: { id: true, name: true } } },
  });
}

// S: academy-facing roster of everyone who registered for a workshop (scoped to the
// owning academy). Includes the registrant's contact fields + their payment row.
export async function getRegistrationsForAcademy(academyId: string, workshopId: string) {
  return (prisma as any).workshopRegistration.findMany({
    where: { workshopId, workshop: { academyId } },
    include: {
      user: { select: { id: true, name: true, phone: true, age: true } },
      payment: { select: { status: true, amountPaise: true, capturedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findRegistration(workshopId: string, userId: string) {
  return (prisma as any).workshopRegistration.findUnique({
    where: { workshopId_userId: { workshopId, userId } },
    include: { payment: true },
  });
}

export async function createRegistration(workshopId: string, userId: string) {
  return (prisma as any).workshopRegistration.create({
    data: { id: (await import('../../lib/id.js')).newId(), workshopId, userId, status: 'pending' },
  });
}

export async function confirmRegistration(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).workshopRegistration.update({
    where: { id },
    data: { status: 'confirmed' },
  });
}

export async function incrementRegisteredCount(id: string, tx?: any) {
  const client = tx ?? prisma;
  return client.workshop.update({
    where: { id },
    data: { registeredCount: { increment: 1 } },
  });
}

export async function createWorkshopPayment(data: {
  id: string;
  registrationId: string;
  amountPaise: number;
  currency: string;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return (prisma as any).workshopPayment.create({ data });
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

export async function create(academyId: string, data: {
  type: 'online' | 'offline';
  title: string;
  description: string;
  startAt: Date;
  durationMin: number;
  location?: string;
  capacity: number;
  pricePaise: number;
  status?: string;
}) {
  return prisma.workshop.create({
    data: { academyId, ...data },
  });
}

export async function update(id: string, data: Partial<{
  type: 'online' | 'offline';
  title: string;
  description: string;
  startAt: Date;
  durationMin: number;
  location?: string;
  capacity: number;
  pricePaise: number;
  status: string;
}>) {
  return prisma.workshop.update({ where: { id }, data });
}

export async function remove(id: string) {
  return prisma.workshop.delete({ where: { id } });
}

export async function findRegistrationById(id: string) {
  return (prisma as any).workshopRegistration.findUnique({
    where: { id },
    include: { workshop: true, payment: true },
  });
}

export async function cancelRegistration(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).workshopRegistration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}

export async function decrementRegisteredCount(workshopId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.workshop.update({
    where: { id: workshopId },
    data: { registeredCount: { decrement: 1 } },
  });
}
