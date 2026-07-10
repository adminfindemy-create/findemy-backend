import { prisma } from '../../lib/prisma.js';

export async function getBatch(id: string, academyId: string) {
  return prisma.batch.findFirst({
    where: { id, academyId },
    include: { timings: true },
  });
}

export async function createSlots(
  slots: { id: string; batchId: string; slotTime: Date; capacity: number }[],
) {
  return prisma.slot.createMany({ data: slots });
}

/**
 * Returns the existing slotTime millisecond values for `batchId` that fall on
 * any candidate timestamp, so callers can dedupe by (batchId, slotTime).
 */
export async function findExistingSlotMillis(
  batchId: string,
  candidates: Date[],
): Promise<Set<number>> {
  if (candidates.length === 0) return new Set();
  const rows = await prisma.slot.findMany({
    where: { batchId, slotTime: { in: candidates } },
    select: { slotTime: true },
  });
  return new Set(rows.map((row) => row.slotTime.getTime()));
}

export async function findSlot(id: string, academyId: string) {
  return prisma.slot.findFirst({
    where: { id, batch: { academyId } },
    include: { batch: { select: { title: true, academyId: true } } },
  });
}

export async function deleteSlot(id: string) {
  return prisma.slot.delete({ where: { id } });
}

export async function updateSlotTime(id: string, slotTime: Date) {
  return prisma.slot.update({ where: { id }, data: { slotTime } });
}

export async function getSlotBookedUserIds(slotId: string): Promise<string[]> {
  const bookings = await prisma.booking.findMany({
    where: { slotId, status: { in: ['initiated', 'confirmed'] } },
    select: { userId: true },
  });
  return [...new Set(bookings.map((booking) => booking.userId))];
}
