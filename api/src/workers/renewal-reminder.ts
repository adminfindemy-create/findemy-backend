import { prisma } from '../lib/prisma.js';
import { sendPushNotifications } from '../modules/push/service.js';
import { LEARNER_PUSH_SELECT, whose } from '../lib/learner-access.js';

export async function sendRenewalReminders() {
  const now = new Date();
  let sent = 0;

  for (const daysAhead of [7, 3, 1]) {
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + daysAhead);
    const startOfDay = new Date(targetDate.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const endOfDay = new Date(targetDate.toISOString().split('T')[0] + 'T23:59:59.999Z');

    const periods = await (prisma as any).enrollmentPeriod.findMany({
      where: {
        status: 'active',
        endDate: { gte: startOfDay, lte: endOfDay },
        remindersSentCount: { lt: daysAhead === 7 ? 1 : daysAhead === 3 ? 2 : 3 },
      },
      include: {
        enrollment: {
          include: {
            user: { select: { id: true } },
            batch: { select: { title: true } }, learner: LEARNER_PUSH_SELECT,
          },
        },
      },
    });

    for (const period of periods) {
      if (period.enrollment.pausedUntil && new Date(period.enrollment.pausedUntil) > now) continue;

      try {
        await sendPushNotifications({
          subjectId: period.enrollment.userId,
          subjectRole: 'student',
          title: `Renewal reminder — ${daysAhead} day${daysAhead > 1 ? 's' : ''} left`,
          body: `${whose(period.enrollment.learner)} ${period.enrollment.batch.title} access expires in ${daysAhead} day${daysAhead > 1 ? 's' : ''}. Tap to renew.`,
          data: { screen: 'renewal', batch_id: period.enrollment.batchId, enrollment_period_id: period.id },
        });
        await (prisma as any).enrollmentPeriod.update({
          where: { id: period.id },
          data: { remindersSentCount: { increment: 1 }, lastReminderSentAt: now },
        });
        sent++;
      } catch { /* non-fatal */ }
    }
  }

  return { sent };
}
