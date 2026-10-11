// Who was supposed to be at a given session — the denominator of every attendance number in the
// product. One definition, shared by the closer (which writes the absences) and the read side
// (which counts them), because two definitions would put two different percentages on two screens.
// See ai-usage/attendance-tracking_plan.md decision 7.
//
//   expected(session) = enrolled before the session
//                     + the session falls inside a paid period
//                     + not paused on that date
//                     + hadn't left yet
//
// Deliberately NOT "all active enrolments": a student who joined on the 20th would show a month of
// red, and a paused student's % would keep falling while their fees are legitimately on hold.
// Deliberately NOT gated on today's `status` either — a student who has since left was still
// expected at the classes they were enrolled for, which is exactly why a past month must keep
// showing their low attendance.
//
// Trials are not attendance and never appear here (Trial.status carries them).

export type ExpectationEnrollment = {
  /** The account that enrolled (a parent, for a child). */
  userId: string;
  /** Who attends. Attendance is per learner, so this is the key everywhere below. */
  learnerId: string;
  startedAt: Date;
  /** Set when the academy/student ended the enrolment; sessions after it are not expected. */
  discontinueRequestedAt: Date | null;
  periods: { startDate: Date; endDate: Date; discontinueEffectiveAt: Date | null }[];
  pauses: { startDate: Date | null; endDate: Date | null }[];
};

/** Day-granular comparison: sessions are `@db.Date`, periods and pauses are day-scale facts. */
function dayOf(d: Date): number {
  return Math.floor(d.getTime() / 86_400_000);
}

export function isExpectedOn(e: ExpectationEnrollment, sessionDate: Date): boolean {
  const day = dayOf(sessionDate);
  if (dayOf(e.startedAt) > day) return false;

  const inPaidPeriod = e.periods.some((p) => dayOf(p.startDate) <= day && day <= dayOf(p.endDate));
  if (!inPaidPeriod) return false;

  const leftAt =
    e.periods.map((p) => p.discontinueEffectiveAt).find((d): d is Date => !!d) ??
    e.discontinueRequestedAt;
  if (leftAt && day > dayOf(leftAt)) return false;

  const paused = e.pauses.some(
    (p) => p.startDate && p.endDate && dayOf(p.startDate) <= day && day <= dayOf(p.endDate),
  );
  return !paused;
}

/** The learner ids expected at one session. */
export function expectedLearnerIdsOn(enrollments: ExpectationEnrollment[], sessionDate: Date): string[] {
  return enrollments.filter((e) => isExpectedOn(e, sessionDate)).map((e) => e.learnerId);
}
