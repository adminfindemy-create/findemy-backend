import { prisma } from '../../lib/prisma.js';

export async function findTrialsByUser(userId: string, statusFilter?: string) {
  const where: Record<string, unknown> = { userId };
  if (statusFilter === 'upcoming') {
    where.trialAt = { gte: new Date() };
  } else if (statusFilter === 'past') {
    where.trialAt = { lt: new Date() };
  }
  return prisma.trial.findMany({
    where,
    orderBy: { trialAt: 'desc' },
    include: {
      academy: { select: { name: true, address: true } },
      batch: { select: { title: true, category: true, trialFeePaise: true, coach: { select: { name: true } } } },
      booking: {
        select: {
          status: true,
          rescheduleCount: true,
          payment: { select: { status: true, amountPaise: true, refundStatus: true } },
        },
      },
    },
  });
}

export async function findTodayTrialsByUser(userId: string) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return prisma.trial.findMany({
    where: {
      userId,
      trialAt: { gte: now, lte: tomorrow },
    },
    orderBy: { trialAt: 'asc' },
    include: {
      academy: { select: { name: true, address: true } },
      batch: { select: { title: true, category: true, trialFeePaise: true, coach: { select: { name: true } } } },
      booking: {
        select: {
          // `status` is read by serializeTrial (effectiveStatus / booking_status);
          // added to match the other trial queries' shape.
          status: true,
          rescheduleCount: true,
          payment: { select: { status: true, amountPaise: true, refundStatus: true } },
        },
      },
    },
  });
}

export async function findTrialById(id: string) {
  return prisma.trial.findUnique({
    where: { id },
    include: {
      academy: { select: { name: true, address: true } },
      batch: { select: { title: true, category: true, trialFeePaise: true, coach: { select: { name: true } } } },
      user: { select: { attendanceOtp: true } },
      booking: {
        select: {
          status: true,
          rescheduleCount: true,
          payment: { select: { status: true, amountPaise: true, refundStatus: true } },
        },
      },
    },
  });
}

export async function markTrialAttendance(
  id: string,
  accountId: string,
) {
  return prisma.trial.update({
    where: { id },
    data: {
      status: 'attended',
      attendanceMarkedAt: new Date(),
      attendanceMarkedByAccountId: accountId,
    },
  });
}

export async function markTrialNoShow(id: string, accountId: string) {
  return prisma.trial.update({
    where: { id },
    data: {
      status: 'missed',
      attendanceMarkedAt: new Date(),
      attendanceMarkedByAccountId: accountId,
    },
  });
}
