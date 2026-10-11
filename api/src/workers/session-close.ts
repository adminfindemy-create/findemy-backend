import { prisma } from '../lib/prisma.js';
import { istDateKey } from '../lib/ist.js';
import { CLOSE_AFTER_MIN, sessionWindowsOn } from '../lib/session-window.js';
import { expectedLearnerIdsOn, type ExpectationEnrollment } from '../lib/attendance-expectation.js';
import { sendPushNotifications } from '../modules/push/service.js';
import * as attendanceRepo from '../modules/attendance/repo.js';

/**
 * Closes finished sessions — the step that turns presence-only data into a real attendance record.
 * 15 min after a class ends:
 *
 *   ≥1 marked    → write `present: false` for every other expected student, stamp `finalisedAt`.
 *   0 marked     → write NOTHING and leave `finalisedAt` null → the session reads as
 *                  "Not recorded" and is excluded from every denominator. The common cause is the
 *                  teacher never entering anyone's code. The academy gets one push while the
 *                  behaviour can still change.
 *
 * Neither outcome is the last word any more. The register is correctable for 24h after the class
 * (attendance/service.ts, correctAttendance) — including a "Not recorded" session, whose first
 * correction finalises it. Before that change absence was permanent, which is why the old QR had
 * to expire before this worker ran; with no token in the flow that constraint is gone.
 */
export async function closeFinishedSessions() {
  const now = new Date();
  // Look back a week: enough to catch a worker outage, bounded so this stays a small query.
  const from = new Date(now.getTime() - 7 * 86_400_000);

  const sessions = await prisma.classSession.findMany({
    where: { status: 'held', finalisedAt: null, sessionDate: { gte: from } },
    include: {
      batch: {
        select: { id: true, title: true, academyId: true, timings: true },
      },
    },
    orderBy: { sessionDate: 'asc' },
  });

  let finalised = 0;
  let notRecorded = 0;

  for (const s of sessions) {
    const closesAt = closingInstant(s.sessionDate, s.batch.timings);
    if (now < closesAt) continue;

    const presence = await prisma.batchAttendance.findMany({
      where: { batchId: s.batchId, date: s.sessionDate, present: true },
      select: { learnerId: true },
    });

    if (presence.length === 0) {
      if (await markZeroScanOnce(s.batchId, s.sessionDate)) {
        await pushZeroScan(s.batch, s.sessionDate);
        notRecorded++;
      }
      continue;
    }

    const enrollments = (await attendanceRepo.getEnrollmentsForExpectation(
      s.batchId,
    )) as ExpectationEnrollment[];
    const expected = expectedLearnerIdsOn(enrollments, s.sessionDate);
    const presentIds = new Set(presence.map((p) => p.learnerId));
    const absentees = expected.filter((learnerId) => !presentIds.has(learnerId));
    const accountOf = new Map(enrollments.map((e) => [e.learnerId, e.userId]));

    await prisma.$transaction(async (tx) => {
      if (absentees.length) {
        await tx.batchAttendance.createMany({
          data: absentees.map((learnerId) => ({
            batchId: s.batchId,
            userId: accountOf.get(learnerId)!,
            learnerId,
            date: s.sessionDate,
            present: false,
            method: 'auto' as const,
            // Stamped so a roster can tell "student scanned" (null) from "system marked".
            markedByAccountId: SYSTEM_MARKER,
          })),
          skipDuplicates: true,
        });
      }
      await tx.classSession.update({
        where: { id: s.id },
        data: { finalisedAt: new Date() },
      });
    });
    finalised++;
  }

  return { finalised, notRecorded };
}

/** `markedByAccountId` value for absences: no human marked them. */
export const SYSTEM_MARKER = 'system';

/**
 * When this session may be closed. A batch can meet twice in a day, so the close follows the LAST
 * timing on that date. If the timetable no longer has that weekday (the academy moved the batch
 * after the class happened) fall back to end-of-day IST + the same grace — the session was real
 * and still has to close.
 */
function closingInstant(sessionDate: Date, timings: { dayOfWeek: number; startTime: string; durationMin: number }[]): Date {
  const windows = sessionWindowsOn(timings, istDateKey(sessionDate));
  if (windows.length) return windows[windows.length - 1].closesAt;
  const endOfDayIst = new Date(sessionDate.getTime() + 24 * 3_600_000 - 5.5 * 3_600_000);
  return new Date(endOfDayIst.getTime() + CLOSE_AFTER_MIN * 60_000);
}

/** One zero-scan push per session, ever — same guard the class reminders use. */
async function markZeroScanOnce(batchId: string, sessionDate: Date): Promise<boolean> {
  try {
    await prisma.sessionReminderSent.create({ data: { batchId, sessionDate, kind: 'zero_scan' } });
    return true;
  } catch (e: any) {
    if (e?.code === 'P2002') return false;
    throw e;
  }
}

async function pushZeroScan(
  batch: { id: string; title: string; academyId: string; timings: { dayOfWeek: number; startTime: string; durationMin: number }[] },
  sessionDate: Date,
) {
  const windows = sessionWindowsOn(batch.timings, istDateKey(sessionDate));
  const startLabel = windows.length
    ? windows[0].start.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : null;
  await sendPushNotifications({
    subjectId: batch.academyId, // push service resolves academyId → AcademyAccount.id
    subjectRole: 'academy',
    title: 'Attendance not recorded',
    body: `${batch.title}${startLabel ? ` ${startLabel}` : ''} — nobody checked in, so this class wasn't recorded.`,
    data: { screen: 'attendance', batch_id: batch.id, session_date: istDateKey(sessionDate) },
  }).catch(() => {});
}
