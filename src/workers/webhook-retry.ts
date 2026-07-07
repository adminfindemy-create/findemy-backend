import { prisma } from '../lib/prisma.js';

export async function retryFailedWebhooks() {
  // For MVP: find payments stuck in 'pending' for > 10 minutes and mark as failed
  const stale = await prisma.payment.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
    },
    include: { booking: true },
  });

  let retried = 0;
  for (const p of stale) {
    await prisma.payment.update({ where: { id: p.id }, data: { status: 'failed' } });
    await prisma.booking.update({
      where: { id: p.bookingId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    // S2.1: legacy slot release only if the booking had a slot (slots retired).
    if (p.booking.slotId) {
      await prisma.slot.update({
        where: { id: p.booking.slotId },
        data: { reservedCount: { decrement: 1 } },
      });
    }
    retried++;
  }
  return { retried };
}
