import { prisma } from '../lib/prisma.js';
import { sendPushNotifications } from '../modules/push/service.js';
import { LEARNER_PUSH_SELECT, whose } from '../lib/learner-access.js';
import { creditPauseCoverage, pauseDurationDays } from '../lib/pause.js';

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export async function runEnrollmentLifecycle() {
  const now = new Date();
  const today = new Date(now.toISOString().split('T')[0] + 'T00:00:00.000Z');
  let processed = 0;

  // 1. active → grace: periods whose endDate has passed with no newer active period
  const activeExpired = await (prisma as any).enrollmentPeriod.findMany({
    where: { status: 'active', endDate: { lt: today } },
    include: {
      enrollment: { include: { user: { select: { id: true } }, batch: { select: { title: true } }, learner: LEARNER_PUSH_SELECT } },
    },
  });

  for (const period of activeExpired) {
    const newerActive = await (prisma as any).enrollmentPeriod.findFirst({
      where: { enrollmentId: period.enrollmentId, status: 'active', id: { not: period.id } },
    });
    if (newerActive) continue;

    await (prisma as any).enrollmentPeriod.update({
      where: { id: period.id },
      data: { status: 'grace' },
    });
    processed++;
    try {
      await sendPushNotifications({
        subjectId: period.enrollment.userId,
        subjectRole: 'student',
        title: 'Paid period ended',
        body: `${whose(period.enrollment.learner)} ${period.enrollment.batch.title} access is in grace period. Renew to continue.`,
        data: { screen: 'enrollments' },
      });
    } catch { /* non-fatal */ }
  }

  // 2. grace → expired: grace period has ended
  const graceExpired = await (prisma as any).enrollmentPeriod.findMany({
    where: { status: 'grace', gracePeriodEnd: { lt: now } },
    include: {
      enrollment: { include: { user: { select: { id: true } }, batch: { select: { title: true } }, learner: LEARNER_PUSH_SELECT } },
    },
  });

  for (const period of graceExpired) {
    await prisma.$transaction(async (tx: any) => {
      await (tx as any).enrollmentPeriod.update({ where: { id: period.id }, data: { status: 'expired' } });
      await (tx as any).enrollment.update({ where: { id: period.enrollmentId }, data: { status: 'inactive' } });
    });
    processed++;
    try {
      await sendPushNotifications({
        subjectId: period.enrollment.userId,
        subjectRole: 'student',
        title: 'Access expired',
        body: `${whose(period.enrollment.learner)} ${period.enrollment.batch.title} access has expired. Renew to continue.`,
        data: { screen: 'enrollments' },
      });
    } catch { /* non-fatal */ }
  }

  // 3. Scheduled discontinuations: discontinueEffectiveAt has passed
  const toDiscontinue = await (prisma as any).enrollmentPeriod.findMany({
    where: {
      status: { in: ['active', 'grace'] },
      discontinueEffectiveAt: { lte: now },
      discontinueRequestedAt: { not: null },
    },
    include: {
      enrollment: { include: { user: { select: { id: true } }, batch: { select: { title: true } }, learner: LEARNER_PUSH_SELECT } },
    },
  });

  for (const period of toDiscontinue) {
    await prisma.$transaction(async (tx: any) => {
      await (tx as any).enrollmentPeriod.update({ where: { id: period.id }, data: { status: 'cancelled' } });
      await (tx as any).enrollment.update({ where: { id: period.enrollmentId }, data: { status: 'inactive' } });
    });
    processed++;
    try {
      await sendPushNotifications({
        subjectId: period.enrollment.userId,
        subjectRole: 'student',
        title: 'Enrollment ended',
        body: `${whose(period.enrollment.learner)} ${period.enrollment.batch.title} access has ended as requested.`,
        data: { screen: 'enrollments' },
      });
    } catch { /* non-fatal */ }
  }

  // 4. Pauses: approved → active when startDate arrives
  const pausesToActivate = await (prisma as any).enrollmentPause.findMany({
    where: { status: 'approved', startDate: { lte: today } },
    include: {
      enrollment: {
        include: {
          user: { select: { id: true } },
          batch: { select: { title: true } }, learner: LEARNER_PUSH_SELECT,
          periods: { where: { status: { in: ['active', 'grace'] } }, take: 1, orderBy: { endDate: 'desc' } },
        },
      },
    },
  });

  for (const pause of pausesToActivate) {
    await (prisma as any).enrollmentPause.update({ where: { id: pause.id }, data: { status: 'active' } });
    await (prisma as any).enrollment.update({ where: { id: pause.enrollmentId }, data: { pausedUntil: pause.endDate } });
    processed++;
  }

  // 5. Pauses: active → ended when endDate passes, extend enrollment period
  const pausesToEnd = await (prisma as any).enrollmentPause.findMany({
    where: { status: 'active', endDate: { lte: today } },
    include: {
      enrollment: {
        include: {
          user: { select: { id: true } },
          batch: { select: { title: true } }, learner: LEARNER_PUSH_SELECT,
          periods: { where: { status: { in: ['active', 'grace'] } }, take: 1, orderBy: { endDate: 'desc' } },
        },
      },
    },
  });

  for (const pause of pausesToEnd) {
    const durationDays = pauseDurationDays(pause.duration) ?? 7;
    const activePeriod = pause.enrollment.periods[0];

    await prisma.$transaction(async (tx: any) => {
      await (tx as any).enrollmentPause.update({ where: { id: pause.id }, data: { status: 'ended' } });
      await (tx as any).enrollment.update({ where: { id: pause.enrollmentId }, data: { pausedUntil: null } });
      // Record the classes the pause window swallowed. The period extension below re-delivers
      // them (a whole-week shift reproduces the batch's weekly timings exactly); this is the
      // count, so the entitled sessions-per-month is provably preserved.
      if (pause.startDate && pause.endDate) {
        await creditPauseCoverage(tx, {
          enrollmentId: pause.enrollmentId,
          batchId: pause.enrollment.batchId,
          from: pause.startDate,
          to: pause.endDate,
        });
      }
      if (activePeriod) {
        const newEndDate = addDays(new Date(activePeriod.endDate), durationDays);
        const newGracePeriodEnd = addDays(newEndDate, 7);
        await (tx as any).enrollmentPeriod.update({
          where: { id: activePeriod.id },
          data: { endDate: newEndDate, gracePeriodEnd: newGracePeriodEnd },
        });
      }
    });
    processed++;
    try {
      await sendPushNotifications({
        subjectId: pause.enrollment.userId,
        subjectRole: 'student',
        title: 'Welcome back',
        body: `${whose(pause.enrollment.learner)} pause for ${pause.enrollment.batch.title} has ended. Access is extended.`,
        data: { screen: 'enrollments' },
      });
    } catch { /* non-fatal */ }
  }

  return { processed };
}
