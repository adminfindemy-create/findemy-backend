import { prisma } from '../lib/prisma.js';
import { sendPushNotifications } from '../modules/push/service.js';
import { projectTrialTimes } from '../modules/batches/service.js';
import { sessionDateIST } from '../lib/ist.js';

const MIN = 60 * 1000;

// S5.2: class + attendance reminders, projected from BatchTiming (slots retired). Windows are
// ≥ the */15 cron cadence so no session is missed; the SessionReminderSent unique row dedupes.
//   class      → [25,40] min ahead          → push enrolled students
//   attendance → [110,125] min ahead, IN-STUDIO → push students (check in with QR) AND the academy
export async function sendClassReminders() {
  const now = new Date();
  const batches = await prisma.batch.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      title: true,
      mode: true,
      academyId: true,
      timings: { select: { dayOfWeek: true, startTime: true } },
      enrollments: { where: { status: 'active' }, select: { userId: true } },
    },
  });

  let sent = 0;
  for (const batch of batches) {
    if (batch.enrollments.length === 0) continue;
    const occurrences = projectTrialTimes(batch.timings, 1); // upcoming week of session datetimes
    for (const start of occurrences) {
      const minsAhead = (start.getTime() - now.getTime()) / MIN;
      const sessionDate = sessionDateIST(start);

      // Class reminder — all modes, to enrolled students.
      if (minsAhead >= 25 && minsAhead <= 40 && (await markOnce(batch.id, sessionDate, 'class'))) {
        for (const enrollment of batch.enrollments) {
          await sendPushNotifications({
            subjectId: enrollment.userId,
            subjectRole: 'student',
            title: 'Class reminder',
            body: `Your ${batch.title} class starts soon`,
            data: { screen: 'classes', batch_id: batch.id },
          }).catch(() => {});
        }
        sent++;
      }

      // Attendance reminder — in-studio only, to students AND the academy (owner decision: both sides).
      if (batch.mode === 'offline' && minsAhead >= 110 && minsAhead <= 125 && (await markOnce(batch.id, sessionDate, 'attendance'))) {
        for (const enrollment of batch.enrollments) {
          await sendPushNotifications({
            subjectId: enrollment.userId,
            subjectRole: 'student',
            title: 'Class today',
            body: `${batch.title} is today — check in with the QR`,
            data: { screen: 'classes', batch_id: batch.id },
          }).catch(() => {});
        }
        await sendPushNotifications({
          subjectId: batch.academyId, // push service resolves academyId → AcademyAccount.id
          subjectRole: 'academy',
          title: 'Class soon',
          body: `Open the check-in QR for ${batch.title}`,
          data: { screen: 'batches', batch_id: batch.id },
        }).catch(() => {});
        sent++;
      }
    }
  }
  return { sent };
}

// Atomic "remind once" — relies on @@unique([batchId, sessionDate, kind]); P2002 = already sent.
async function markOnce(batchId: string, sessionDate: Date, kind: 'class' | 'attendance'): Promise<boolean> {
  try {
    await prisma.sessionReminderSent.create({ data: { batchId, sessionDate, kind } });
    return true;
  } catch (error: any) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
}
