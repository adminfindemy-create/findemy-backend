import { prisma } from '../../lib/prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RESERVE_RELEASE_DAYS = 60;

// Create a reserve tranche (10% of captured gross by default), held for 60 days.
// Runs inside the capture transaction when a `tx` is passed.
export async function createReserveHold(
  args: { financialEntityId: string; amountPaise: number; sourceType: string; sourceId: string; heldAt?: Date; reserveRateBps?: number },
  tx?: any,
) {
  const db = tx ?? prisma;
  const rateBps = args.reserveRateBps ?? 1000;
  const amount = Math.floor((args.amountPaise * rateBps) / 10000);
  if (amount <= 0) return null;
  const heldAt = args.heldAt ?? new Date();
  return db.reserveHold.create({
    data: {
      financialEntityId: args.financialEntityId,
      amountPaise: amount,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      heldAt,
      releaseAt: new Date(heldAt.getTime() + RESERVE_RELEASE_DAYS * DAY_MS),
    },
  });
}

// Held (not released, not fully consumed) tranches that can cover a refund, oldest first.
export async function getAvailableHolds(financialEntityId: string) {
  return prisma.reserveHold.findMany({
    where: { financialEntityId, status: 'held' },
    orderBy: { heldAt: 'asc' },
  });
}

export async function consumeHold(id: string, consumedPaise: number, fullyConsumed: boolean) {
  return prisma.reserveHold.update({
    where: { id },
    data: { consumedPaise, ...(fullyConsumed ? { status: 'consumed' } : {}) },
  });
}

export async function createRecovery(args: {
  financialEntityId: string;
  grossPaise: number;
  reserveAppliedPaise: number;
  negativePaise: number;
  sourceType: string;
  sourceId: string;
}) {
  return prisma.academyRecovery.create({ data: args });
}

export async function getReserveSummary(financialEntityId: string) {
  const holds = await prisma.reserveHold.findMany({ where: { financialEntityId } });
  let held = 0;
  let released = 0;
  for (const h of holds) {
    if (h.status === 'held') held += h.amountPaise - h.consumedPaise;
    else if (h.status === 'released') released += h.amountPaise - h.consumedPaise;
  }
  const recoveries = await prisma.academyRecovery.aggregate({ where: { financialEntityId }, _sum: { negativePaise: true } });
  return {
    reserve_held_paise: held,
    reserve_released_paise: released,
    outstanding_recovery_paise: recoveries._sum.negativePaise ?? 0,
  };
}

// Worker step: release matured reserve tranches (releaseAt passed) back to the academy.
export async function releaseMaturedReserve(now: Date) {
  const matured = await prisma.reserveHold.findMany({
    where: { status: 'held', releaseAt: { lte: now } },
    select: { id: true },
  });
  if (matured.length === 0) return 0;
  await prisma.reserveHold.updateMany({
    where: { id: { in: matured.map((m) => m.id) } },
    data: { status: 'released' },
  });
  return matured.length;
}
