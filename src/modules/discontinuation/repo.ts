import { prisma } from '../../lib/prisma.js';
import type { BatchStatus } from '@prisma/client';

export async function getBatchForAcademy(batchId: string, academyId: string) {
  return prisma.batch.findFirst({ where: { id: batchId, academyId } });
}

export async function setBatchStatus(
  batchId: string,
  status: BatchStatus,
  discontinueRequestedAt?: Date | null,
) {
  return prisma.batch.update({
    where: { id: batchId },
    data: {
      status,
      ...(discontinueRequestedAt !== undefined ? { discontinueRequestedAt } : {}),
    },
  });
}

// Active enrolments on the batch, with their periods (latest first) and student name.
// Used to compute discontinuation blockers (students with a future paid-through date).
export async function getActiveEnrollmentsWithPeriods(batchId: string) {
  return prisma.enrollment.findMany({
    where: { batchId, status: 'active' },
    include: {
      user: { select: { id: true, name: true } },
      periods: {
        where: { status: { in: ['active', 'grace'] } },
        orderBy: { endDate: 'desc' },
        select: { id: true, endDate: true, packageType: true, amountPaise: true },
      },
    },
  });
}

export async function getActiveEnrolledUserIds(batchId: string): Promise<string[]> {
  const rows = await prisma.enrollment.findMany({
    where: { batchId, status: 'active' },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// Booked, still-upcoming trials on the batch — cancelled when the batch is discontinued.
// (The trial-fee refund is issued in Slice 6.) Returns the cancelled trials for notifying.
export async function cancelBookedFutureTrials(batchId: string, now: Date) {
  const trials = await prisma.trial.findMany({
    where: { batchId, status: 'booked', trialAt: { gt: now } },
    select: { id: true, userId: true, bookingId: true },
  });
  if (trials.length === 0) return [];
  await prisma.$transaction([
    prisma.trial.updateMany({
      where: { id: { in: trials.map((t) => t.id) } },
      data: { status: 'cancelled' },
    }),
    prisma.booking.updateMany({
      where: { id: { in: trials.map((t) => t.bookingId).filter((b): b is string => !!b) } },
      data: { status: 'cancelled', cancelledAt: now },
    }),
  ]);
  return trials;
}

// Captured trial payments for the given bookings — refunded when trials are cancelled on discontinue.
export async function getCapturedTrialPayments(bookingIds: string[]) {
  if (bookingIds.length === 0) return [];
  return prisma.payment.findMany({
    where: { bookingId: { in: bookingIds }, status: 'captured' },
    select: { id: true, bookingId: true, amountPaise: true, razorpayPaymentId: true },
  });
}

// Pending pause requests on the batch's enrolments — auto-rejected on discontinuation.
export async function cancelPendingPauses(batchId: string, now: Date) {
  return prisma.enrollmentPause.updateMany({
    where: { enrollment: { batchId }, status: 'pending' },
    data: { status: 'rejected', rejectedAt: now, rejectedReason: 'Batch discontinued' },
  });
}
