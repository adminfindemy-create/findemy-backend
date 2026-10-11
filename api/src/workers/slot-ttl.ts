import { prisma } from '../lib/prisma.js';

export async function releaseExpiredReservations() {
  const expired = await prisma.booking.findMany({
    where: {
      status: 'initiated',
      reservationExpiresAt: { lt: new Date() },
    },
    select: { id: true, slotId: true },
  });

  let released = 0;
  for (const b of expired) {
    // Cancel the expired unpaid reservation. S2.1: only touch a slot for legacy
    // bookings that still have one (trial booking is off capacity now — no slots).
    await prisma.booking.update({
      where: { id: b.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    if (b.slotId) {
      await prisma.slot.update({
        where: { id: b.slotId },
        data: { reservedCount: { decrement: 1 } },
      });
    }
    released++;
  }
  return { released };
}
