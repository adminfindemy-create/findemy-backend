import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import * as repo from './repo.js';

export function serializeTrial(trial: Awaited<ReturnType<typeof repo.findTrialsByUser>>[number]) {
  const booking = (trial as any).booking ?? null;
  const payment = booking?.payment ?? null;
  // If the parent booking is cancelled but the trial row never got synced,
  // show the trial as cancelled — UI shouldn't offer Cancel on a dead booking.
  const effectiveStatus =
    booking?.status === 'cancelled' && trial.status === 'booked'
      ? 'cancelled'
      : trial.status;
  return {
    id: trial.id,
    user_id: trial.userId,
    academy_id: trial.academyId,
    batch_id: trial.batchId,
    slot_id: trial.slotId,
    booking_id: trial.bookingId,
    trial_at: trial.trialAt.toISOString(),
    status: effectiveStatus,
    attendance_marked_at: trial.attendanceMarkedAt?.toISOString() ?? null,
    attendance_marked_by_account_id: trial.attendanceMarkedByAccountId,
    created_at: trial.createdAt.toISOString(),
    academy_name: trial.academy.name,
    academy_address: trial.academy.address,
    batch_title: trial.batch.title,
    batch_category: trial.batch.category,
    coach_name: (trial as any).batch.coach?.name ?? null,
    trial_fee_paise: (trial as any).batch.trialFeePaise ?? 0,
    slot_time: trial.trialAt.toISOString(), // S2.1: from trialAt (slots retired)
    booking_status: booking?.status ?? null,
    reschedule_count: booking?.rescheduleCount ?? 0,
    payment_status: payment?.status ?? null,
    payment_amount_paise: payment?.amountPaise ?? 0,
    refund_status: payment?.refundStatus ?? null,
  };
}

export async function getMyTrials(
  userId: string,
  status?: 'upcoming' | 'past',
) {
  const trials = await repo.findTrialsByUser(userId, status);
  return { items: trials.map(serializeTrial) };
}

export async function getTodayTrials(userId: string) {
  const trials = await repo.findTodayTrialsByUser(userId);
  return { items: trials.map(serializeTrial) };
}

export async function getTrialById(id: string) {
  const trial = await repo.findTrialById(id);
  if (!trial) throw new AppError('NOT_FOUND', 404, 'Trial not found');
  return {
    trial: serializeTrial(trial as unknown as Awaited<ReturnType<typeof repo.findTrialsByUser>>[number]),
  };
}

// In-memory rate limiter for attendance OTP attempts
const attemptStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = attemptStore.get(key);
  if (!entry || now > entry.resetAt) {
    attemptStore.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  if (entry.count > max) {
    return true;
  }
  attemptStore.set(key, entry);
  return false;
}

export async function markAttendance({
  trialId,
  accountId,
  otpCode,
  academyId,
}: {
  trialId: string;
  accountId: string;
  otpCode: string;
  academyId: string;
}) {
  const trial = await repo.findTrialById(trialId);
  if (!trial) throw new AppError('NOT_FOUND', 404, 'Trial not found');
  if (trial.academyId !== academyId) {
    throw new AppError('FORBIDDEN', 403, 'Trial does not belong to your academy');
  }
  if (trial.status !== 'booked') {
    throw new AppError('VALIDATION', 400, 'Trial not in booked state');
  }

  const slotTime = trial.trialAt;
  const now = new Date();
  if (
    now < new Date(slotTime.getTime() - 60 * 60 * 1000) ||
    now > new Date(slotTime.getTime() + 30 * 60 * 1000)
  ) {
    throw new AppError('VALIDATION', 400, 'Outside attendance window');
  }

  const rateLimited = checkRateLimit(
    `attend:${trialId}`,
    5,
    10 * 60 * 1000,
  );
  if (rateLimited) {
    throw new AppError('RATE_LIMITED', 429, 'Too many attempts');
  }

  // Timing-safe compare
  const expected = Buffer.from(trial.user.attendanceOtp, 'utf-8');
  const provided = Buffer.from(otpCode, 'utf-8');
  if (expected.length !== provided.length) {
    throw new AppError('OTP_MISMATCH', 403, 'Wrong code');
  }
  if (!crypto.timingSafeEqual(expected, provided)) {
    throw new AppError('OTP_MISMATCH', 403, 'Wrong code');
  }

  const updated = await repo.markTrialAttendance(trialId, accountId);
  return {
    trial: serializeTrial(updated as unknown as Awaited<ReturnType<typeof repo.findTrialsByUser>>[number]),
    marked_at: updated.attendanceMarkedAt!.toISOString(),
  };
}

export async function markNoShow({
  trialId,
  accountId,
  academyId,
}: {
  trialId: string;
  accountId: string;
  academyId: string;
}) {
  const trial = await repo.findTrialById(trialId);
  if (!trial) throw new AppError('NOT_FOUND', 404, 'Trial not found');
  if (trial.academyId !== academyId) {
    throw new AppError('FORBIDDEN', 403, 'Trial does not belong to your academy');
  }
  if (trial.status !== 'booked') {
    throw new AppError('VALIDATION', 400, 'Trial not in booked state');
  }
  const updated = await repo.markTrialNoShow(trialId, accountId);
  return { trial_id: updated.id, status: updated.status };
}
