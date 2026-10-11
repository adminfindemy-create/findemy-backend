// Minimal in-memory fixed-window rate limiter. Used to throttle admin auth (no rate-limiting
// existed in the backend). Single-process only — fine for the current single-instance deploy;
// swap for a Redis-backed limiter if the API is horizontally scaled.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count >= opts.limit) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}
