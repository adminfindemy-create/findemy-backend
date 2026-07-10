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
  for (const booking of expired) {
    // Cancel the expired unpaid reservation. S2.1: only touch a slot for legacy
    // bookings that still have one (trial booking is off capacity now — no slots).
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    if (booking.slotId) {
      await prisma.slot.update({
        where: { id: booking.slotId },
        data: { reservedCount: { decrement: 1 } },
      });
    }
    released++;
  }
  return { released };
}
