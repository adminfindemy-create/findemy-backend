import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { istWallClockToUtc, istDateKey } from '../../lib/ist.js';
import { TRIAL_AVAILABILITY_WEEKS } from '../../config.js';
import { createEnrollmentWithPeriod, renewEnrollment, getEnrollmentRenewalOptions } from '../enrollments/service.js';

// S2.1: project a batch's weekly timings forward into bookable trial datetimes.
// S5.2: exported so the class/attendance-reminder worker shares one projection source.
export function projectTrialTimes(
  timings: { dayOfWeek: number; startTime: string }[],
  weeks = TRIAL_AVAILABILITY_WEEKS,
): Date[] {
  const now = new Date();
  const projectedTimes: Date[] = [];
  // Walk each calendar day in the window and check it against every weekly timing —
  // simpler and less error-prone than computing "next occurrence of weekday X" directly.
  for (let dayOffset = 0; dayOffset < weeks * 7; dayOffset++) {
    const dateStr = istDateKey(new Date(now.getTime() + dayOffset * 86400000));
    const dayOfWeek = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    for (const timing of timings) {
      if (timing.dayOfWeek !== dayOfWeek) continue;
      const [hour, minute] = timing.startTime.split(':').map(Number);
      const instant = istWallClockToUtc(dateStr, hour, minute);
      if (instant > now) projectedTimes.push(instant);
    }
  }
  return projectedTimes.sort((timeA, timeB) => timeA.getTime() - timeB.getTime());
}

// S3.4: the first class occurrence STRICTLY AFTER `after`, from the batch's weekly timings.
// Used by the make-good: extending a period to its next real session adds exactly one class
// (a flat "+7 days" would add 0 or 2 for a multi-session-per-week batch).
export function nextTimingOccurrenceAfter(
  after: Date,
  timings: { dayOfWeek: number; startTime: string }[],
  withinDays = 60,
): Date | null {
  for (let dayOffset = 0; dayOffset <= withinDays; dayOffset++) {
    const dateStr = istDateKey(new Date(after.getTime() + dayOffset * 86400000));
    const dayOfWeek = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    const timesOnThisDay = timings
      .filter((timing) => timing.dayOfWeek === dayOfWeek)
      .map((timing) => {
        const [hour, minute] = timing.startTime.split(':').map(Number);
        return istWallClockToUtc(dateStr, hour, minute);
      })
      .filter((instant) => instant > after)
      .sort((timeA, timeB) => timeA.getTime() - timeB.getTime());
    if (timesOnThisDay.length) return timesOnThisDay[0];
  }
  return null;
}

/** S2.1: trial booking availability — upcoming class sessions where capacity − enrolled > 0. */
export async function getTrialAvailability(batchId: string) {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, include: { timings: true } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  const availability = await getBatchAvailability(batchId);
  const upcomingTimes = availability.available > 0 ? projectTrialTimes(batch.timings) : [];
  return {
    capacity: availability.capacity,
    enrolled: availability.enrolled,
    available: availability.available, // trials do NOT consume this (capacity − enrolled headroom)
    accepting: availability.accepting,
    times: upcomingTimes.map((time) => time.toISOString()),
  };
}

/** Is `trialAt` one of the batch's projected upcoming class sessions? */
export async function assertValidTrialTime(batchId: string, trialAtIso: string): Promise<Date> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, include: { timings: true } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  const target = new Date(trialAtIso);
  const isValidSession = projectTrialTimes(batch.timings).some((time) => time.getTime() === target.getTime());
  if (!isValidSession) throw new AppError('VALIDATION', 400, 'Selected time is not an available class session');
  return target;
}

export async function enrollStudent(batchId: string, userId: string, packageType: string) {
  const validPackages = ['monthly', 'quarterly', 'annual'];
  if (!validPackages.includes(packageType)) {
    throw new AppError('VALIDATION', 400, 'Invalid package type. Use: monthly, quarterly, or annual');
  }
  return createEnrollmentWithPeriod(batchId, userId, packageType as any);
}

export async function unenrollStudent(batchId: string, userId: string) {
  await prisma.enrollment.updateMany({
    where: { userId, batchId },
    data: { status: 'inactive' },
  });
  return { enrolled: false };
}

export async function getEnrollmentStatus(batchId: string, userId: string) {
  const enrollment = await prisma.enrollment.findUnique({
    where: { userId_batchId: { userId, batchId } },
  });
  return { enrolled: enrollment?.status === 'active' };
}

export async function getBatchRenewalOptions(batchId: string, userId: string) {
  return getEnrollmentRenewalOptions(batchId, userId);
}

export async function renewBatchEnrollment(batchId: string, userId: string, packageType: string) {
  const validPackages = ['monthly', 'quarterly', 'annual'];
  if (!validPackages.includes(packageType)) {
    throw new AppError('VALIDATION', 400, 'Invalid package type. Use: monthly, quarterly, or annual');
  }
  return renewEnrollment(batchId, userId, packageType as any);
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
