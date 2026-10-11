import { prisma } from '../../lib/prisma.js';

export async function findSlotsByBatch(batchId: string, date?: string) {
  const where: any = { batchId };
  if (date) {
    const start = new Date(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const now = new Date();
    const lowerBound = start < now && now < end ? now : start;
    where.slotTime = { gte: lowerBound, lt: end };
  }
  return prisma.slot.findMany({ where, orderBy: { slotTime: 'asc' } });
}
