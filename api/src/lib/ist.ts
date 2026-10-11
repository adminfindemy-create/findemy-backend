// Findemy is a single-market (India) product and IST has no DST, so a fixed
// +05:30 offset is exact. These helpers are pure offset math — they never
// touch Date.prototype.getHours/setHours, so results do not depend on the
// host machine's timezone. See docs .../05-group-e-schedule-time.md for the
// "one fixed app timezone" convention.
const IST_OFFSET_MIN = 5 * 60 + 30; // +05:30

/**
 * Returns the UTC instant whose IST wall-clock is `dateStr` at `hh:mm`.
 * `dateStr` is a 'yyyy-MM-dd' IST calendar date.
 */
export function istWallClockToUtc(dateStr: string, hh: number, mm: number): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  // Compose the wall-clock as if it were UTC, then subtract the IST offset
  // to land on the true UTC instant.
  const asUtcMillis = Date.UTC(y, (mo ?? 1) - 1, d ?? 1, hh, mm, 0, 0);
  return new Date(asUtcMillis - IST_OFFSET_MIN * 60_000);
}

/** IST calendar date ('yyyy-MM-dd') of a UTC instant. */
export function istDateKey(instant: Date): string {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * S3.2/S3.3: the IST start-of-day Date for an instant, for the `@db.Date` attendance key.
 * Both attendance writers (QR check-in + online auto-on-join) MUST use this so they share
 * the same `(batchId, userId, date)` row regardless of the UTC date boundary.
 */
export function sessionDateIST(instant: Date = new Date()): Date {
  return new Date(`${istDateKey(instant)}T00:00:00.000Z`);
}
