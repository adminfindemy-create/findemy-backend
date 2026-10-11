import { prisma } from '../../lib/prisma.js';

export async function findSlotById(id: string, tx?: any) {
  const client = tx ?? prisma;
  return client.slot.findUnique({
    where: { id },
    include: { batch: true },
  });
}

export async function reserveSlot(slotId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.slot.update({
    where: { id: slotId },
    data: { reservedCount: { increment: 1 } },
  });
}

export async function releaseSlot(slotId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.slot.update({
    where: { id: slotId },
    data: { reservedCount: { decrement: 1 } },
  });
}

export async function createBooking(data: {
  id: string;
  userId: string;
  learnerId: string;
  batchId: string;
  trialAt: Date;
  status: string;
  reservationExpiresAt: Date;
}, tx?: any) {
  const client = tx ?? prisma;
  return client.booking.create({ data });
}

export async function findBookingById(id: string) {
  return prisma.booking.findUnique({
    where: { id },
    include: { batch: true, slot: true, payment: true, trial: true },
  });
}

export async function findBookingByIdAndUser(id: string, userId: string) {
  return prisma.booking.findFirst({
    where: { id, userId },
    include: {
      batch: { include: { academy: true } },
      slot: true,
      payment: true,
      trial: true,
      learner: { select: { id: true, name: true } },
    },
  });
}

export async function cancelBooking(id: string, tx?: any) {
  const client = tx ?? prisma;
  return client.booking.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}

export async function cancelTrialForBooking(bookingId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.trial.updateMany({
    where: { bookingId, status: 'booked' },
    data: { status: 'cancelled' },
  });
}

export async function rescheduleBooking(id: string, newTrialAt: Date) {
  // S2.1: reschedule = move the trial time; no slot reservation to swap.
  return prisma.booking.update({
    where: { id },
    data: { trialAt: newTrialAt, rescheduleCount: { increment: 1 }, status: 'rescheduled' },
  });
}
