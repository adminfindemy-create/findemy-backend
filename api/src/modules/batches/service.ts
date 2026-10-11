import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { istWallClockToUtc, istDateKey } from '../../lib/ist.js';
import { TRIAL_AVAILABILITY_WEEKS } from '../../config.js';
import { createEnrollmentWithPeriod, renewEnrollment, getEnrollmentRenewalOptions } from '../enrollments/service.js';
import { resolveLearner } from '../../lib/learner-access.js';

// S2.1: project a batch's weekly timings forward into bookable trial datetimes.
// S5.2: exported so the class/attendance-reminder worker shares one projection source.
export function projectTrialTimes(
  timings: { dayOfWeek: number; startTime: string }[],
  weeks = TRIAL_AVAILABILITY_WEEKS,
): Date[] {
  const now = new Date();
  const out: Date[] = [];
  for (let d = 0; d < weeks * 7; d++) {
    const dateStr = istDateKey(new Date(now.getTime() + d * 86400000));
    const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    for (const t of timings) {
      if (t.dayOfWeek !== dow) continue;
      const [hh, mm] = t.startTime.split(':').map(Number);
      const instant = istWallClockToUtc(dateStr, hh, mm);
      if (instant > now) out.push(instant);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

// S3.4: the first class occurrence STRICTLY AFTER `after`, from the batch's weekly timings.
// Used by the make-good: extending a period to its next real session adds exactly one class
// (a flat "+7 days" would add 0 or 2 for a multi-session-per-week batch).
export function nextTimingOccurrenceAfter(
  after: Date,
  timings: { dayOfWeek: number; startTime: string }[],
  withinDays = 60,
): Date | null {
  for (let d = 0; d <= withinDays; d++) {
    const dateStr = istDateKey(new Date(after.getTime() + d * 86400000));
    const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    const todays = timings
      .filter((t) => t.dayOfWeek === dow)
      .map((t) => {
        const [hh, mm] = t.startTime.split(':').map(Number);
        return istWallClockToUtc(dateStr, hh, mm);
      })
      .filter((inst) => inst > after)
      .sort((a, b) => a.getTime() - b.getTime());
    if (todays.length) return todays[0];
  }
  return null;
}

/** S2.1: trial booking availability — upcoming class sessions where capacity − enrolled > 0. */
export async function getTrialAvailability(batchId: string) {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, include: { timings: true } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  const avail = await getBatchAvailability(batchId);
  const times = avail.available > 0 ? projectTrialTimes(batch.timings) : [];
  return {
    capacity: avail.capacity,
    enrolled: avail.enrolled,
    available: avail.available, // trials do NOT consume this (capacity − enrolled headroom)
    accepting: avail.accepting,
    times: times.map((t) => t.toISOString()),
  };
}

/** Is `trialAt` one of the batch's projected upcoming class sessions? */
export async function assertValidTrialTime(batchId: string, trialAtIso: string): Promise<Date> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, include: { timings: true } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  const target = new Date(trialAtIso);
  const ok = projectTrialTimes(batch.timings).some((t) => t.getTime() === target.getTime());
  if (!ok) throw new AppError('VALIDATION', 400, 'Selected time is not an available class session');
  return target;
}

// `learnerId` names which of the account's learners this is for; omitted → the account holder.
export async function enrollStudent(batchId: string, userId: string, packageType: string, learnerId?: string) {
  const validPackages = ['monthly', 'quarterly', 'annual'];
  if (!validPackages.includes(packageType)) {
    throw new AppError('VALIDATION', 400, 'Invalid package type. Use: monthly, quarterly, or annual');
  }
  return createEnrollmentWithPeriod(batchId, userId, packageType as any, learnerId);
}

export async function unenrollStudent(batchId: string, userId: string, learnerId?: string) {
  const learner = await resolveLearner(userId, learnerId);
  await prisma.enrollment.updateMany({
    where: { learnerId: learner.id, batchId },
    data: { status: 'inactive' },
  });
  return { enrolled: false };
}

export async function getEnrollmentStatus(batchId: string, userId: string, learnerId?: string) {
  const learner = await resolveLearner(userId, learnerId);
  const enrollment = await prisma.enrollment.findUnique({
    where: { learnerId_batchId: { learnerId: learner.id, batchId } },
  });
  return { enrolled: enrollment?.status === 'active' };
}

export async function getBatchRenewalOptions(batchId: string, userId: string, learnerId?: string) {
  return getEnrollmentRenewalOptions(batchId, userId, learnerId);
}

export async function renewBatchEnrollment(batchId: string, userId: string, packageType: string, learnerId?: string) {
  const validPackages = ['monthly', 'quarterly', 'annual'];
  if (!validPackages.includes(packageType)) {
    throw new AppError('VALIDATION', 400, 'Invalid package type. Use: monthly, quarterly, or annual');
  }
  return renewEnrollment(batchId, userId, packageType as any, learnerId);
}

export async function getBatchAvailability(batchId: string) {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, select: { capacity: true, status: true } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  const activeCount = await prisma.enrollment.count({ where: { batchId, status: 'active' } });
  return {
    capacity: batch.capacity,
    enrolled: activeCount,
    available: Math.max(0, batch.capacity - activeCount),
    accepting: batch.status === 'active' && activeCount < batch.capacity,
  };
}
