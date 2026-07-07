import { prisma } from '../../lib/prisma.js';

export async function getBatchAttendance(batchId: string, date: Date) {
  return prisma.batchAttendance.findMany({
    where: { batchId, date },
    include: { user: { select: { id: true, name: true, phone: true } } },
  });
}

// S3.2/S3.3: the shared "mark present" write. Used by QR check-in (in-studio) AND online
// auto-on-join. `markedByAccountId` is null (student-driven / auto). Idempotent on (batch,user,date).
export async function recordPresent(userId: string, batchId: string, date: Date, tx?: any) {
  const db = tx ?? prisma;
  return db.batchAttendance.upsert({
    where: { batchId_userId_date: { batchId, userId, date } },
    create: { batchId, userId, date, present: true, markedByAccountId: null, markedAt: new Date() },
    update: { present: true, markedAt: new Date() },
  });
}

// Active enrolees of a batch — the roster denominator.
export async function getActiveEnrollees(batchId: string) {
  return prisma.enrollment.findMany({
    where: { batchId, status: 'active' },
    select: { userId: true, user: { select: { name: true } } },
    orderBy: { startedAt: 'asc' },
  });
}
