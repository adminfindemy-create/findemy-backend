// S4.1: one attendance-tier engine, shared by every roster surface so they never disagree.
//
// The denominator is EXPECTED sessions, not attendance rows: S3.2 only ever writes `present`
// rows (no `recordAbsent`), so present/total-of-rows would be 100% for everyone. Expected =
// the batch's sessionsPerMonth (S3.4) × months elapsed since the student enrolled.

export type AttendanceTier = 'active' | 'irregular' | 'inactive';

/** Expected sessions to date for an enrolment (rounded). 0 when too new to score. */
export function expectedSessions(sessionsPerMonth: number, startedAt: Date, now: Date = new Date()): number {
  const ms = now.getTime() - startedAt.getTime();
  if (ms <= 0) return 0;
  const months = ms / (1000 * 60 * 60 * 24 * 30.44); // avg month
  return Math.round(sessionsPerMonth * months);
}

/** Attendance % = present / expected, capped at 100. `null` when expected is 0 ("New"). */
export function attendancePct(present: number, expected: number): number | null {
  if (expected <= 0) return null;
  return Math.min(100, Math.round((present / expected) * 100));
}

/** Active ≥75 · Irregular 50–74 · Inactive <50 · null → null ("New"). */
export function tierOf(pct: number | null): AttendanceTier | null {
  if (pct === null) return null;
  if (pct >= 75) return 'active';
  if (pct >= 50) return 'irregular';
  return 'inactive';
}
