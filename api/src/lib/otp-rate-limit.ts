/**
 * In-memory attempt limiter for attendance codes.
 *
 * Shared by trials and class attendance: both let an academy type a student's 4-digit code, and
 * 10,000 combinations is only safe if guessing is bounded. Keyed per subject (per trial, or per
 * student per session) so one student's wrong entries never lock out the rest of the class.
 *
 * In-process on purpose — it guards a human typing on one device, not a distributed attack. A
 * multi-instance deployment would need this in Redis.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

/** True when the caller has exceeded `max` attempts inside `windowMs`. */
export function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  attempts.set(key, entry);
  return entry.count > max;
}
