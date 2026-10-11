import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { sendPushNotifications } from '../modules/push/service.js';
import { LEARNER_PUSH_SELECT, whose } from '../lib/learner-access.js';

export function startTrialReminderJob() {
  // Runs every hour — finds trials starting 23–25 hours from now that haven't been reminded
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const windowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const trials = await prisma.trial.findMany({
      where: {
        trialAt: { gte: windowStart, lte: windowEnd },
        status: 'booked',
        reminderSent: false,
      },
      include: {
        academy: { select: { name: true } },
        learner: LEARNER_PUSH_SELECT,
      },
    });

    for (const trial of trials) {
      try {
        await sendPushNotifications({
          subjectId: trial.userId,
          subjectRole: 'student',
          title: 'Trial tomorrow',
          // This job runs ~24h ahead; the 1-hour reminder is workers/trial-reminder.ts.
          body: `${whose(trial.learner)} trial at ${trial.academy.name} is tomorrow`,
          data: { screen: 'trials' },
        });
        await prisma.trial.update({
          where: { id: trial.id },
          data: { reminderSent: true },
        });
      } catch {
        // Non-fatal — will retry next hour if reminderSent stays false
      }
    }
  });
}
