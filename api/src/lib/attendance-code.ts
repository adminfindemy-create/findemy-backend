import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// Attendance codes: a different 4-digit code for every class and every trial.
//
// A learner reads their code out and the teacher types it in. The code is derived — HMAC of the
// learner and the occasion under a server secret — so nothing is stored or expired, yet:
//   - each class day has its own code (yesterday's is useless today);
//   - siblings, and the same child in two batches, get different codes;
//   - nobody can know a code before the app is handed it, because the API only reveals it inside
//     the window (class: 10 min before start → end; trial: 1 h before → 30 min after).
// Verification recomputes the same value. Wrong guesses are rate-limited per learner per session.

const LENGTH = 4;

function key(): Buffer {
  return createHash('sha256')
    .update(`findemy-attendance-code:${env.ATTENDANCE_CODE_SECRET ?? env.JWT_PRIVATE_KEY}`)
    .digest();
}

function derive(scope: string): string {
  const digest = createHmac('sha256', key()).update(scope).digest();
  return String(digest.readUInt32BE(0) % 10 ** LENGTH).padStart(LENGTH, '0');
}

/** A learner's code for one class day of one batch. `sessionDate` is the IST day, 'yyyy-MM-dd'. */
export function classCode(learnerId: string, batchId: string, sessionDate: string): string {
  return derive(`class:${batchId}:${sessionDate}:${learnerId}`);
}

/** A learner's code for one trial. */
export function trialCode(learnerId: string, trialId: string): string {
  return derive(`trial:${trialId}:${learnerId}`);
}

/** Constant-time comparison of a typed code against the expected one. */
export function codesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(provided, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}
