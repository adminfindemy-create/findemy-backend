import { prisma } from '../lib/prisma.js';
import { sendPushNotifications } from '../modules/push/service.js';

export async function sendTrialReminders() {
  const now = new Date();
  // Window 55–65 min out — wider than the */5 cron so no trial slips between runs; the durable
  // `reminder1hSent` flag (separate from the 23–25h `reminderSent`) prevents any double-send.
  const trials = await prisma.trial.findMany({
    where: {
      status: 'booked',
      reminder1hSent: false,
      trialAt: { gte: new Date(now.getTime() + 55 * 60 * 1000), lte: new Date(now.getTime() + 65 * 60 * 1000) },
    },
    include: { user: true, batch: true },
  });

  let sent = 0;
  for (const t of trials) {
    await sendPushNotifications({
      subjectId: t.userId,
      subjectRole: 'student',
      title: 'Trial reminder',
      body: `Your trial for ${t.batch.title} is in 1 hour`,
      data: { screen: 'bookings', trialId: t.id },
    });
    await prisma.trial.update({ where: { id: t.id }, data: { reminder1hSent: true } });
    sent++;
  }
  return { sent };
}
