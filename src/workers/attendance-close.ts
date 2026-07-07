import { prisma } from '../lib/prisma.js';

export async function closeMissedTrials() {
  const now = new Date();
  const trials = await prisma.trial.findMany({
    where: {
      status: 'booked',
      trialAt: { lt: new Date(now.getTime() - 30 * 60 * 1000) },
    },
  });

  let closed = 0;
  for (const t of trials) {
    await prisma.trial.update({
      where: { id: t.id },
      data: { status: 'missed' },
    });
    closed++;
  }
  return { closed };
}
