import { checkRateLimit } from '../../lib/otp-rate-limit.js';
import { AppError } from '../../lib/app-error.js';
import * as repo from './repo.js';
import { codesMatch, trialCode } from '../../lib/attendance-code.js';

/** A trial's code is shown and accepted from this long before the trial… */
export const TRIAL_CODE_OPENS_BEFORE_MIN = 60;
/** …until this long after it starts. */
export const TRIAL_CODE_CLOSES_AFTER_MIN = 30;

function trialCodeWindow(trialAt: Date) {
  return {
    opensAt: new Date(trialAt.getTime() - TRIAL_CODE_OPENS_BEFORE_MIN * 60_000),
    closesAt: new Date(trialAt.getTime() + TRIAL_CODE_CLOSES_AFTER_MIN * 60_000),
  };
}
import type { BatchScope } from '../../lib/scope.js';

// `withCode` only on the guardian's own reads: the academy must never be handed the code it is
// supposed to be told. Even then the code is only included inside the trial's window; before it,
// `attendance_code` is null and `attendance_code_opens_at` says when it appears.
export function serializeTrial(
  trial: Awaited<ReturnType<typeof repo.findTrialsByUser>>[number],
  opts: { withCode?: boolean; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const codeWindow = trialCodeWindow(trial.trialAt);
  const codeOpen = trial.status === 'booked' && now >= codeWindow.opensAt && now <= codeWindow.closesAt;
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
    learner_id: trial.learnerId,
    learner: trial.learner ? { id: trial.learner.id, name: trial.learner.name } : null,
    ...(opts.withCode
      ? {
          attendance_code: codeOpen && trial.learnerId ? trialCode(trial.learnerId, trial.id) : null,
          attendance_code_opens_at: codeWindow.opensAt.toISOString(),
        }
      : {}),
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
  return { items: trials.map((t) => serializeTrial(t, { withCode: true })) };
}

export async function getTodayTrials(userId: string) {
  const trials = await repo.findTodayTrialsByUser(userId);
  return { items: trials.map((t) => serializeTrial(t, { withCode: true })) };
}

export async function getTrialById(id: string, userId: string) {
  const trial = await repo.findTrialById(id);
  // Only the account that booked it. Before family profiles this read had no owner check at all.
  if (!trial || trial.userId !== userId) throw new AppError('NOT_FOUND', 404, 'Trial not found');
  return {
    trial: serializeTrial(trial as unknown as Awaited<ReturnType<typeof repo.findTrialsByUser>>[number], {
      withCode: true,
    }),
  };
}


/**
 * A trial belongs to a BRANCH and to a BATCH. The branch check is what it always was; the
 * batch check is new, and is what stops a teacher verifying an attendance code for a trial on
 * another coach's class.
 *
 * `batchId` is compared rather than joined because `findTrialById` already loads it — one
 * fewer query on a path that runs while a student is standing at the desk.
 */
function trialInScope(
  trial: { academyId: string; batch?: { coachId?: string | null } | null; batchId: string },
  scope: BatchScope,
): boolean {
  if (trial.academyId !== scope.academyId) return false;
  if (scope.coachId === undefined) return true;
  const coachId = trial.batch?.coachId;
  return !!coachId && scope.coachId.in.includes(coachId);
}

export async function markAttendance({
  trialId,
  accountId,
  otpCode,
  scope,
}: {
  trialId: string;
  accountId: string;
  otpCode: string;
  scope: BatchScope;
}) {
  const trial = await repo.findTrialById(trialId);
  if (!trial) throw new AppError('NOT_FOUND', 404, 'Trial not found');
  if (!trialInScope(trial, scope)) {
    throw new AppError('FORBIDDEN', 403, 'Trial does not belong to your academy');
  }
  if (trial.status !== 'booked') {
    throw new AppError('VALIDATION', 400, 'Trial not in booked state');
  }

  const now = new Date();
  const { opensAt, closesAt } = trialCodeWindow(trial.trialAt);
  if (now < opensAt || now > closesAt) {
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

  // This trial's own code for the learner it is for — different for every trial and every child.
  if (!codesMatch(trialCode(trial.learnerId, trial.id), otpCode)) {
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
  scope,
}: {
  trialId: string;
  accountId: string;
  scope: BatchScope;
}) {
  const trial = await repo.findTrialById(trialId);
  if (!trial) throw new AppError('NOT_FOUND', 404, 'Trial not found');
  if (!trialInScope(trial, scope)) {
    throw new AppError('FORBIDDEN', 403, 'Trial does not belong to your academy');
  }
  if (trial.status !== 'booked') {
    throw new AppError('VALIDATION', 400, 'Trial not in booked state');
  }
  const updated = await repo.markTrialNoShow(trialId, accountId);
  return { trial_id: updated.id, status: updated.status };
}
