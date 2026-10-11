import { prisma } from '../lib/prisma.js';
import { sendPushNotifications } from '../modules/push/service.js';
import { LEARNER_PUSH_SELECT, whose } from '../lib/learner-access.js';
import { projectTrialTimes } from '../modules/batches/service.js';
import { sessionDateIST } from '../lib/ist.js';

const MIN = 60 * 1000;

// S5.2: class + attendance reminders, projected from BatchTiming (slots retired). Windows are
// ≥ the */15 cron cadence so no session is missed; the SessionReminderSent unique row dedupes.
//   class      → [25,40] min ahead          → push enrolled students
//   attendance → [110,125] min ahead, IN-STUDIO → push students (have the code ready) AND the academy
// One push per enrolled LEARNER, naming a child, so a parent with two children in a batch gets
// one for each.
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
      enrollments: { where: { status: 'active' }, select: { userId: true, learner: LEARNER_PUSH_SELECT } },
    },
  });

  let sent = 0;
  for (const b of batches) {
    if (b.enrollments.length === 0) continue;
    const occurrences = projectTrialTimes(b.timings, 1); // upcoming week of session datetimes
    for (const start of occurrences) {
      const minsAhead = (start.getTime() - now.getTime()) / MIN;
      const sessionDate = sessionDateIST(start);

      // Class reminder — all modes, to enrolled students.
      if (minsAhead >= 25 && minsAhead <= 40 && (await markOnce(b.id, sessionDate, 'class'))) {
        for (const e of b.enrollments) {
          await sendPushNotifications({
            subjectId: e.userId,
            subjectRole: 'student',
            title: 'Class reminder',
            body: `${whose(e.learner)} ${b.title} class starts soon`,
            data: { screen: 'classes', batch_id: b.id },
          }).catch(() => {});
        }
        sent++;
      }

      // Attendance reminder — in-studio only, to students AND the academy (owner decision: both sides).
      if (b.mode === 'offline' && minsAhead >= 110 && minsAhead <= 125 && (await markOnce(b.id, sessionDate, 'attendance'))) {
        for (const e of b.enrollments) {
          await sendPushNotifications({
            subjectId: e.userId,
            subjectRole: 'student',
            title: 'Class today',
            // The QR is gone: the teacher enters the learner's code from the app.
            body: `${whose(e.learner)} ${b.title} class is today — have the attendance code ready in the app`,
            data: { screen: 'classes', batch_id: b.id },
          }).catch(() => {});
        }
        await sendPushNotifications({
          subjectId: b.academyId, // push service resolves academyId → AcademyAccount.id
          subjectRole: 'academy',
          title: 'Class soon',
          body: `${b.title} is today — take attendance by entering each student's code`,
          data: { screen: 'batches', batch_id: b.id },
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
  } catch (e: any) {
    if (e?.code === 'P2002') return false;
    throw e;
  }
}
