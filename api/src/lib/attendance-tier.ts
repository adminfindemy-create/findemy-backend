// S4.1: one attendance-tier engine, shared by every roster surface so they never disagree.
//
// The denominator is no longer a formula. It used to be `sessionsPerMonth × months since enrolment`,
// because only `present` rows were ever written — the app had no way to know a class happened or
// that someone was missing. Sessions are records now (ClassSession) and absence is a written fact,
// so the denominator is the real one: finalised held sessions the student was expected at. That
// counting lives in modules/attendance/stats.ts; what stays here is how a ratio becomes a badge.

export type AttendanceTier = 'active' | 'irregular' | 'inactive';

/**
 * Below this many expected sessions a percentage is noise — 0% or 100% off one class says nothing
 * about a student. Such rows show "1/1 · New" with no percentage and sort last.
 */
export const MIN_EXPECTED_FOR_PCT = 3;

/** Attendance % = present / expected, capped at 100. `null` when there's too little signal. */
export function attendancePct(present: number, expected: number): number | null {
  if (expected < MIN_EXPECTED_FOR_PCT) return null;
  return Math.min(100, Math.round((present / expected) * 100));
}

/**
 * Active ≥75 · Irregular 50–74 · Inactive <50 · null → null ("New").
 * Thresholds deliberately unchanged: every percentage the app has shown so far came from a
 * formula, so retuning the bands now would be guessing. Revisit after a few accurate months.
 */
export function tierOf(pct: number | null): AttendanceTier | null {
  if (pct === null) return null;
  if (pct >= 75) return 'active';
  if (pct >= 50) return 'irregular';
  return 'inactive';
}
