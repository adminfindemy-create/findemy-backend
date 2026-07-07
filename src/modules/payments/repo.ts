import { prisma } from '../../lib/prisma.js';
import { computeCommission, computeReversal } from '../../lib/commission.js';

export async function findBookingWithSlot(id: string) {
  return prisma.booking.findUnique({
    where: { id },
    include: { batch: true, slot: true, user: true },
  });
}

export async function createPayment(data: {
  id: string;
  bookingId: string;
  amountPaise: number;
  currency: string;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return prisma.payment.create({ data });
}

export async function findPaymentById(id: string) {
  return prisma.payment.findUnique({
    where: { id },
    include: { booking: { include: { batch: true, slot: true } } },
  });
}

export async function findPaymentByOrderId(razorpayOrderId: string) {
  return prisma.payment.findUnique({
    where: { razorpayOrderId },
    include: {
      booking: {
        include: {
          batch: { include: { academy: { select: { id: true, name: true } } } },
          slot: true,
          user: true,
        },
      },
    },
  });
}

export async function updatePaymentCaptured(
  id: string,
  razorpayPaymentId: string,
  tx?: any,
) {
  const client = tx ?? prisma;
  return client.payment.update({
    where: { id },
    data: {
      status: 'captured',
      razorpayPaymentId,
      capturedAt: new Date(),
    },
  });
}

export async function updatePaymentFailed(id: string, tx?: any) {
  const client = tx ?? prisma;
  return client.payment.update({
    where: { id },
    data: { status: 'failed' },
  });
}

export async function confirmBooking(bookingId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.booking.update({
    where: { id: bookingId },
    data: { status: 'confirmed', paidAt: new Date() },
  });
}

export async function createTrial(data: {
  id: string;
  userId: string;
  academyId: string;
  batchId: string;
  bookingId: string;
  trialAt: Date;
}, tx?: any) {
  const client = tx ?? prisma;
  return client.trial.create({ data });
}

export async function releaseSlot(slotId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.slot.update({
    where: { id: slotId },
    data: { reservedCount: { decrement: 1 } },
  });
}

export async function updatePaymentRefunded(id: string, razorpayRefundId: string, amountPaise: number, tx?: any) {
  const client = tx ?? prisma;
  return client.payment.update({
    where: { id },
    data: { refundStatus: 'requested', razorpayRefundId, refundAmountPaise: amountPaise },
  });
}

export async function updateWorkshopPaymentRefunded(id: string, razorpayRefundId: string, amountPaise: number, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).workshopPayment.update({
    where: { id },
    data: { refundStatus: 'requested', razorpayRefundId, refundAmountPaise: amountPaise },
  });
}

export async function updateEventPaymentRefunded(id: string, razorpayRefundId: string, amountPaise: number, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).eventPayment.update({
    where: { id },
    data: { refundStatus: 'requested', razorpayRefundId, refundAmountPaise: amountPaise },
  });
}

export async function updateEnrollmentPaymentRefunded(id: string, razorpayRefundId: string, amountPaise: number, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPayment.update({
    where: { id },
    data: { refundStatus: 'requested', razorpayRefundId, refundAmountPaise: amountPaise },
  });
}

export async function findEnrollmentPaymentByOrderId(razorpayOrderId: string) {
  return (prisma as any).enrollmentPayment.findUnique({
    where: { razorpayOrderId },
    include: {
      enrollmentPeriod: {
        include: {
          enrollment: { include: { batch: { include: { academy: { select: { id: true, name: true } } } }, user: true } },
        },
      },
    },
  });
}

export async function updateEnrollmentPaymentCaptured(id: string, razorpayPaymentId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPayment.update({
    where: { id },
    data: { status: 'captured', razorpayPaymentId, capturedAt: new Date() },
  });
}

export async function updateEnrollmentPaymentFailed(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPayment.update({
    where: { id },
    data: { status: 'failed' },
  });
}

export async function activateEnrollmentPeriod(enrollmentPeriodId: string, enrollmentId: string, tx?: any) {
  const client = tx ?? prisma;
  await (client as any).enrollmentPeriod.update({
    where: { id: enrollmentPeriodId },
    data: { status: 'active' },
  });
  await (client as any).enrollment.update({
    where: { id: enrollmentId },
    data: { status: 'active', currentPeriodId: enrollmentPeriodId },
  });
}

export async function findEventPaymentByOrderId(razorpayOrderId: string) {
  return (prisma as any).eventPayment.findUnique({
    where: { razorpayOrderId },
    include: {
      registration: { include: { event: true, user: true } },
    },
  });
}

export async function updateEventPaymentCaptured(id: string, razorpayPaymentId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).eventPayment.update({
    where: { id },
    data: { status: 'captured', razorpayPaymentId, capturedAt: new Date() },
  });
}

export async function updateEventPaymentFailed(id: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).eventPayment.update({
    where: { id },
    data: { status: 'failed' },
  });
}

export async function confirmEventRegistration(registrationId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).eventRegistration.update({
    where: { id: registrationId },
    data: { status: 'confirmed' },
  });
}

export async function incrementEventEnrolledCount(eventId: string, tx?: any) {
  const client = tx ?? prisma;
  return client.event.update({
    where: { id: eventId },
    data: { enrolledCount: { increment: 1 } },
  });
}

export async function findPaymentByIdempotencyKey(idempotencyKey: string) {
  return prisma.payment.findUnique({ where: { idempotencyKey } });
}

// ── S2.4: commission ledger ──────────────────────────────────────────────
type CommissionItemType = 'trial' | 'enrollment' | 'workshop' | 'event';

/** Write one commission row (idempotent on itemType+itemId). Call inside the capture txn. */
export async function recordCommission(
  data: { academyId: string; itemType: CommissionItemType; itemId: string; grossPaise: number },
  tx?: any,
) {
  const db = tx ?? prisma;
  const existing = await db.commissionLedger.findUnique({
    where: { itemType_itemId: { itemType: data.itemType, itemId: data.itemId } },
  });
  if (existing) return existing; // re-delivered webhook — no double-write
  const { commissionBps, commissionPaise } = computeCommission(data.grossPaise);
  return db.commissionLedger.create({
    data: {
      academyId: data.academyId,
      itemType: data.itemType,
      itemId: data.itemId,
      grossPaise: data.grossPaise,
      commissionBps,
      commissionPaise,
    },
  });
}

/** Reverse commission proportionally to a refund (full refund → fully reversed). Idempotent. */
export async function reverseCommission(
  itemType: CommissionItemType,
  itemId: string,
  refundPaise: number,
  tx?: any,
) {
  const db = tx ?? prisma;
  const row = await db.commissionLedger.findUnique({
    where: { itemType_itemId: { itemType, itemId } },
  });
  if (!row || row.status === 'reversed') return row ?? null;
  const reversedPaise = computeReversal(row.commissionPaise, row.grossPaise, refundPaise);
  return db.commissionLedger.update({
    where: { id: row.id },
    data: { reversedPaise, status: reversedPaise >= row.commissionPaise ? 'reversed' : row.status },
  });
}
