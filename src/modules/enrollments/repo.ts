import { prisma } from '../../lib/prisma.js';

export async function findEnrollmentById(id: string) {
  return (prisma as any).enrollment.findUnique({
    where: { id },
    include: {
      batch: { include: { academy: true } },
      user: { select: { id: true, name: true } },
      periods: { orderBy: { createdAt: 'desc' }, take: 1 },
      pauses: { where: { status: { in: ['pending', 'approved', 'active'] } }, take: 1 },
    },
  });
}

export async function findEnrollmentByIdAndUser(id: string, userId: string) {
  return (prisma as any).enrollment.findFirst({
    where: { id, userId },
    include: {
      batch: { include: { academy: true } },
      periods: { orderBy: { createdAt: 'desc' }, take: 1 },
      pauses: { where: { status: { in: ['pending', 'approved', 'active'] } }, orderBy: { requestedAt: 'desc' }, take: 1 },
    },
  });
}

export async function findActivePeriod(enrollmentId: string) {
  return (prisma as any).enrollmentPeriod.findFirst({
    where: { enrollmentId, status: { in: ['active', 'grace'] } },
    orderBy: { endDate: 'desc' },
    include: { payment: true },
  });
}

export async function findLatestPeriod(enrollmentId: string) {
  return (prisma as any).enrollmentPeriod.findFirst({
    where: { enrollmentId },
    orderBy: { endDate: 'desc' },
  });
}

export async function createEnrollmentPeriod(data: {
  id: string;
  enrollmentId: string;
  packageType: string;
  startDate: Date;
  endDate: Date;
  amountPaise: number;
  gracePeriodEnd: Date;
}) {
  return (prisma as any).enrollmentPeriod.create({ data });
}

export async function createEnrollmentPayment(data: {
  id: string;
  enrollmentPeriodId: string;
  amountPaise: number;
  currency: string;
  razorpayOrderId: string;
  idempotencyKey: string;
}) {
  return (prisma as any).enrollmentPayment.create({ data });
}

export async function findEnrollmentPaymentByIdempotencyKey(idempotencyKey: string) {
  return (prisma as any).enrollmentPayment.findUnique({ where: { idempotencyKey } });
}

export async function cancelEnrollmentPeriod(periodId: string, reason: string, immediate: boolean, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPeriod.update({
    where: { id: periodId },
    data: {
      discontinueRequestedAt: new Date(),
      discontinueReason: reason,
      discontinueEffectiveAt: immediate ? new Date() : undefined,
    },
  });
}

export async function setEnrollmentInactive(enrollmentId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollment.update({
    where: { id: enrollmentId },
    data: { status: 'inactive', discontinueRequestedAt: new Date() },
  });
}

export async function clearDiscontinuation(periodId: string, enrollmentId: string, tx?: any) {
  const client = tx ?? prisma;
  await (client as any).enrollmentPeriod.update({
    where: { id: periodId },
    data: { discontinueRequestedAt: null, discontinueEffectiveAt: null, discontinueReason: null },
  });
  await (client as any).enrollment.update({
    where: { id: enrollmentId },
    data: { discontinueRequestedAt: null },
  });
}

export async function setEnrollmentPeriodCancelled(periodId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPeriod.update({
    where: { id: periodId },
    data: { status: 'cancelled' },
  });
}

export async function createPause(data: {
  id: string;
  enrollmentId: string;
  duration: string;
  reason?: string;
  status: string;
  startDate?: Date;
  endDate?: Date;
}) {
  return (prisma as any).enrollmentPause.create({ data });
}

export async function findPauseById(id: string) {
  return (prisma as any).enrollmentPause.findUnique({ where: { id } });
}

export async function updatePauseApproved(pauseId: string, startDate: Date, endDate: Date, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPause.update({
    where: { id: pauseId },
    data: { status: 'approved', approvedAt: new Date(), startDate, endDate },
  });
}

export async function updatePauseRejected(pauseId: string, reason: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPause.update({
    where: { id: pauseId },
    data: { status: 'rejected', rejectedAt: new Date(), rejectedReason: reason },
  });
}

export async function updatePauseResumed(pauseId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPause.update({
    where: { id: pauseId },
    data: { status: 'ended', resumedAt: new Date() },
  });
}

export async function extendPeriodEndDate(periodId: string, newEndDate: Date, newGracePeriodEnd: Date, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollmentPeriod.update({
    where: { id: periodId },
    data: { endDate: newEndDate, gracePeriodEnd: newGracePeriodEnd },
  });
}

export async function updateEnrollmentPausedUntil(enrollmentId: string, pausedUntil: Date | null, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).enrollment.update({
    where: { id: enrollmentId },
    data: { pausedUntil },
  });
}

export async function createTransferRequest(data: {
  id: string;
  fromEnrollmentId: string;
  toBatchId: string;
  reason?: string;
}) {
  return (prisma as any).batchTransferRequest.create({ data });
}

export async function findTransferRequestById(id: string) {
  return (prisma as any).batchTransferRequest.findUnique({
    where: { id },
    include: {
      fromEnrollment: { include: { batch: { include: { academy: true } }, user: true } },
      toBatch: { include: { academy: true } },
    },
  });
}

export async function updateTransferApproved(requestId: string, newEnrollmentId: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).batchTransferRequest.update({
    where: { id: requestId },
    data: { status: 'approved', approvedAt: new Date(), newEnrollmentId },
  });
}

export async function updateTransferRejected(requestId: string, reason: string, tx?: any) {
  const client = tx ?? prisma;
  return (client as any).batchTransferRequest.update({
    where: { id: requestId },
    data: { status: 'rejected', rejectedAt: new Date(), rejectedReason: reason },
  });
}

export async function setPreferredPackage(enrollmentId: string, packageType: string) {
  return (prisma as any).enrollment.update({
    where: { id: enrollmentId },
    data: { defaultPackage: packageType },
  });
}

export async function countActiveEnrollments(batchId: string) {
  return prisma.enrollment.count({ where: { batchId, status: 'active' } });
}

export async function findEnrollmentsForBatch(batchId: string) {
  return (prisma as any).enrollment.findMany({
    where: { batchId },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      periods: { where: { status: { in: ['active', 'grace'] } }, take: 1, orderBy: { endDate: 'desc' } },
    },
    orderBy: { startedAt: 'desc' },
  });
}

export async function findPendingPausesForAcademy(academyId: string) {
  return (prisma as any).enrollmentPause.findMany({
    where: { status: 'pending', enrollment: { batch: { academyId } } },
    include: { enrollment: { include: { user: { select: { id: true, name: true } }, batch: { select: { id: true, title: true } } } } },
    orderBy: { requestedAt: 'asc' },
  });
}

export async function findPendingTransfersForAcademy(academyId: string) {
  return (prisma as any).batchTransferRequest.findMany({
    where: { status: 'pending', toBatch: { academyId } },
    include: {
      fromEnrollment: { include: { user: { select: { id: true, name: true } }, batch: { select: { id: true, title: true } } } },
      toBatch: { select: { id: true, title: true } },
    },
    orderBy: { requestedAt: 'asc' },
  });
}
