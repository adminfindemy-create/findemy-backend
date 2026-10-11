import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { MIN_PAYOUT_PAISE } from '../../config.js';
import * as rzpx from '../../lib/razorpayx.js';
import { writeAudit } from '../admin/audit.js';

// The weekly payout engine. It CONSUMES the outputs of the already-automatic money layer
// (commission accrual, reserve holds/releases, refund recoveries) — it never re-implements them,
// so there is no double counting. Per academy, per weekly period:
//
//   periodNet = captured − commission − reserveAccrued + reserveReleased
//   net       = (periodNet + carryIn) − recoveryApplied
//
// where captured/commission come from CommissionLedger, reserve from ReserveHold, and recovery
// (negativePaise the academy owes) from AcademyRecovery. Idempotent per period via the
// @@unique([academyId, periodStart]) guard.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// biome-ignore lint/suspicious/noExplicitAny: Prisma tx client type isn't cleanly exported.
type Db = PrismaClient | any;

// Sunday 00:00:00.000 UTC of the week containing `d`.
export function startOfWeekUTC(d: Date): Date {
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  s.setUTCDate(s.getUTCDate() - s.getUTCDay());
  return s;
}

// The week that just ended (what the Sunday cron settles).
export function previousPeriod(now: Date): { periodStart: Date; periodEnd: Date } {
  const thisWeek = startOfWeekUTC(now);
  return { periodStart: new Date(thisWeek.getTime() - WEEK_MS), periodEnd: thisWeek };
}

// The in-progress week (handy for manual runs that must include today's captures).
export function currentPeriod(now: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = startOfWeekUTC(now);
  return { periodStart, periodEnd: new Date(periodStart.getTime() + WEEK_MS) };
}

export type PayoutComputation = {
  grossPaise: number;
  commissionPaise: number;
  reserveHeldPaise: number;
  reserveReleasedPaise: number;
  carriedInPaise: number;
  recoveryAppliedPaise: number;
  netPaise: number;
  status: 'pending' | 'skipped';
};

// Pure-ish gather of the period figures for one FINANCIAL ENTITY (read-only). Branches that
// share an entity settle together — which also pools the below-MIN carry-forward instead of
// stalling each branch separately under the threshold.
async function gather(
  db: Db,
  financialEntityId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{
  grossPaise: number;
  commissionPaise: number;
  reserveHeldPaise: number;
  reserveReleasedPaise: number;
  carriedInPaise: number;
  outstandingRecoveryPaise: number;
}> {
  const inPeriod = { gte: periodStart, lt: periodEnd };

  // Captured gross + net commission for the period (single source: CommissionLedger).
  const comm = await db.commissionLedger.aggregate({
    where: { financialEntityId, createdAt: inPeriod },
    _sum: { grossPaise: true, commissionPaise: true, reversedPaise: true },
  });
  const grossPaise = comm._sum.grossPaise ?? 0;
  const commissionPaise = (comm._sum.commissionPaise ?? 0) - (comm._sum.reversedPaise ?? 0);

  // Reserve withheld this period (10% tranches created in-period).
  const held = await db.reserveHold.aggregate({
    where: { financialEntityId, heldAt: inPeriod },
    _sum: { amountPaise: true },
  });
  const reserveHeldPaise = held._sum.amountPaise ?? 0;

  // Reserve released back this period: matured tranches (net of any consumed-by-refund portion).
  const released = await db.reserveHold.findMany({
    where: { financialEntityId, status: 'released', releaseAt: inPeriod },
    select: { amountPaise: true, consumedPaise: true },
  });
  const reserveReleasedPaise = released.reduce(
    (sum: number, h: { amountPaise: number; consumedPaise: number }) =>
      sum + (h.amountPaise - h.consumedPaise),
    0,
  );

  // Positive net from prior skipped (below-MIN) periods, not yet absorbed.
  const priorSkipped = await db.payout.aggregate({
    where: { financialEntityId, status: 'skipped', carryConsumed: false, periodStart: { lt: periodStart } },
    _sum: { netPaise: true },
  });
  const carriedInPaise = priorSkipped._sum.netPaise ?? 0;

  // Outstanding recovery the academy owes (negativePaise not yet netted).
  const recoveries = await db.academyRecovery.findMany({
    where: { financialEntityId },
    select: { negativePaise: true, appliedPaise: true },
  });
  const outstandingRecoveryPaise = recoveries.reduce(
    (sum: number, r: { negativePaise: number; appliedPaise: number }) =>
      sum + Math.max(0, r.negativePaise - r.appliedPaise),
    0,
  );

  return {
    grossPaise,
    commissionPaise,
    reserveHeldPaise,
    reserveReleasedPaise,
    carriedInPaise,
    outstandingRecoveryPaise,
  };
}

// Pure computation of the payout figures from gathered inputs — unit-tested directly.
export function computeNet(inputs: {
  grossPaise: number;
  commissionPaise: number;
  reserveHeldPaise: number;
  reserveReleasedPaise: number;
  carriedInPaise: number;
  outstandingRecoveryPaise: number;
  minPayoutPaise?: number;
}): PayoutComputation {
  const min = inputs.minPayoutPaise ?? MIN_PAYOUT_PAISE;
  const periodNet =
    inputs.grossPaise -
    inputs.commissionPaise -
    inputs.reserveHeldPaise +
    inputs.reserveReleasedPaise;
  const available = periodNet + inputs.carriedInPaise;

  let recoveryAppliedPaise = 0;
  let netPaise = available;
  let status: 'pending' | 'skipped';

  if (available < min) {
    // Not enough to cut a transfer; carry the (possibly small/zero/negative) balance forward.
    status = 'skipped';
  } else {
    // Net down the academy's outstanding debt from available funds (never below zero).
    recoveryAppliedPaise = Math.min(inputs.outstandingRecoveryPaise, available);
    netPaise = available - recoveryAppliedPaise;
    status = netPaise >= min ? 'pending' : 'skipped';
  }

  return {
    grossPaise: inputs.grossPaise,
    commissionPaise: inputs.commissionPaise,
    reserveHeldPaise: inputs.reserveHeldPaise,
    reserveReleasedPaise: inputs.reserveReleasedPaise,
    carriedInPaise: inputs.carriedInPaise,
    recoveryAppliedPaise,
    netPaise,
    status,
  };
}

// Compute + persist one financial entity's payout for the period (idempotent). Returns the
// row, or null if there was nothing to pay out (no activity). Runs inside `tx`.
export async function computePayoutForEntity(
  tx: Db,
  financialEntityId: string,
  periodStart: Date,
  periodEnd: Date,
) {
  const existing = await tx.payout.findUnique({
    where: { financialEntityId_periodStart: { financialEntityId, periodStart } },
  });
  // idempotent: never recompute a period once written. `created:false` so a re-run isn't miscounted.
  if (existing) return { payout: existing, created: false };

  const g = await gather(tx, financialEntityId, periodStart, periodEnd);

  // Nothing happened for this entity this period → don't create a noise row.
  const hasActivity =
    g.grossPaise > 0 ||
    g.reserveReleasedPaise > 0 ||
    g.carriedInPaise > 0 ||
    g.outstandingRecoveryPaise > 0;
  if (!hasActivity) return null;
  // (created below)

  const c = computeNet(g);

  const payout = await tx.payout.create({
    data: {
      financialEntityId,
      periodStart,
      periodEnd,
      grossPaise: c.grossPaise,
      commissionPaise: c.commissionPaise,
      reserveHeldPaise: c.reserveHeldPaise,
      reserveReleasedPaise: c.reserveReleasedPaise,
      carriedInPaise: c.carriedInPaise,
      recoveryAppliedPaise: c.recoveryAppliedPaise,
      netPaise: c.netPaise,
      amountPaise: c.netPaise,
      status: c.status,
    },
  });

  // Absorb prior skipped rows we rolled in (so their netPaise isn't double-counted next period).
  if (c.carriedInPaise > 0) {
    await tx.payout.updateMany({
      where: { financialEntityId, status: 'skipped', carryConsumed: false, periodStart: { lt: periodStart } },
      data: { carryConsumed: true },
    });
  }

  // Mark the recovery we actually netted (oldest debt first).
  if (c.recoveryAppliedPaise > 0) {
    let remaining = c.recoveryAppliedPaise;
    const debts = await tx.academyRecovery.findMany({
      where: { financialEntityId },
      orderBy: { createdAt: 'asc' },
    });
    for (const d of debts) {
      if (remaining <= 0) break;
      const owed = d.negativePaise - d.appliedPaise;
      if (owed <= 0) continue;
      const draw = Math.min(owed, remaining);
      await tx.academyRecovery.update({
        where: { id: d.id },
        data: { appliedPaise: d.appliedPaise + draw },
      });
      remaining -= draw;
    }
  }

  return { payout, created: true };
}

// Run the compute for every payable FINANCIAL ENTITY for a period — i.e. every entity backing
// at least one approved branch. Two branches on one entity therefore produce ONE payout row per
// period, not two. Each entity is its own transaction so one failure doesn't abort the batch.
export async function runPayouts(periodStart: Date, periodEnd: Date) {
  const entities = await prisma.financialEntity.findMany({
    where: { branches: { some: { status: 'approved' } } },
    select: { id: true },
  });

  let created = 0;
  let existing = 0;
  let skipped = 0;
  let pending = 0;
  for (const a of entities) {
    const result = await prisma.$transaction((tx) =>
      computePayoutForEntity(tx, a.id, periodStart, periodEnd),
    );
    if (!result) continue; // no activity → no row
    if (!result.created) {
      existing++;
      continue;
    }
    created++;
    if (result.payout.status === 'skipped') skipped++;
    if (result.payout.status === 'pending') pending++;
  }
  return { periodStart, periodEnd, entities: entities.length, created, existing, pending, skipped };
}

// ---------- Execution (money out via RazorpayX) ----------

async function fireTransfer(payout: {
  id: string;
  netPaise: number;
  financialEntityId: string;
}): Promise<{ rzpTransferId: string }> {
  const entity = await prisma.financialEntity.findUnique({
    where: { id: payout.financialEntityId },
    select: { rzpFundAccountId: true, branches: { select: { status: true } } },
  });
  if (!entity?.rzpFundAccountId) {
    throw new Error('Financial entity has no RazorpayX FundAccount (bank KYC incomplete)');
  }
  // Suspension is a per-BRANCH state but payment is per entity: freeze the transfer only when
  // the entity has no branch still in good standing, so suspending one of three locations
  // doesn't withhold the other two's money.
  if (entity.branches.length > 0 && entity.branches.every((b) => b.status === 'suspended')) {
    throw new Error('All branches on this financial entity are suspended; payouts are frozen');
  }
  const res = await rzpx.createPayout({
    fundAccountId: entity.rzpFundAccountId,
    amountPaise: payout.netPaise,
    referenceId: payout.id,
  });
  return { rzpTransferId: res.id };
}

// Move an approved payout into `processing` by firing the RazorpayX transfer.
export async function executePayout(payoutId: string, tx: Db = prisma) {
  const payout = await tx.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new Error('Payout not found');
  if (payout.status !== 'approved') {
    throw new Error(`Payout not approved (status=${payout.status})`);
  }
  const { rzpTransferId } = await fireTransfer(payout);
  return tx.payout.update({
    where: { id: payoutId },
    data: { status: 'processing', rzpTransferId, failureReason: null },
  });
}

// Retry a failed payout: re-fire the transfer.
export async function retryPayout(payoutId: string) {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new Error('Payout not found');
  if (payout.status !== 'failed') throw new Error(`Only failed payouts can be retried (status=${payout.status})`);
  const { rzpTransferId } = await fireTransfer(payout);
  return prisma.payout.update({
    where: { id: payoutId },
    data: { status: 'processing', rzpTransferId, failureReason: null },
  });
}

// Approve a pending payout, then fire its transfer. On execution failure the row is marked
// `failed` (retryable) rather than left dangling. Writes an audit row.
export async function approvePayout(actorId: string, payoutId: string) {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new Error('Payout not found');
  if (payout.status !== 'pending') {
    throw new Error(`Only pending payouts can be approved (status=${payout.status})`);
  }

  await prisma.payout.update({
    where: { id: payoutId },
    data: { status: 'approved', approvedByAdminId: actorId, approvedAt: new Date() },
  });
  await writeAudit({
    adminId: actorId,
    action: 'payout.approve',
    targetType: 'Payout',
    targetId: payoutId,
    after: { netPaise: payout.netPaise, financialEntityId: payout.financialEntityId },
  });

  try {
    return await executePayout(payoutId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'transfer failed';
    return prisma.payout.update({
      where: { id: payoutId },
      data: { status: 'failed', failureReason: reason },
    });
  }
}

export async function approveAllPending(actorId: string, periodStart?: Date) {
  const pending = await prisma.payout.findMany({
    where: { status: 'pending', ...(periodStart ? { periodStart } : {}) },
    select: { id: true },
  });
  const results: { id: string; status: string }[] = [];
  for (const p of pending) {
    const row = await approvePayout(actorId, p.id);
    results.push({ id: p.id, status: row.status });
  }
  return { approved: results.length, results };
}

// ---------- Reconcile / webhook (settle processing → paid/failed) ----------

// Settle a single processing payout. Mock ids (RazorpayX absent) resolve to paid with a mock UTR,
// mirroring how issueRazorpayRefund/ refund-reconcile degrade without real keys.
export async function settleProcessingPayout(payout: {
  id: string;
  rzpTransferId: string | null;
}): Promise<'paid' | 'failed' | 'pending'> {
  if (!payout.rzpTransferId) return 'pending';
  if (payout.rzpTransferId.startsWith('pout_mock_')) {
    await prisma.payout.update({
      where: { id: payout.id },
      data: { status: 'paid', utr: `UTRMOCK${payout.id.slice(-8).toUpperCase()}`, paidAt: new Date() },
    });
    return 'paid';
  }
  // Real path would poll RazorpayX here; left to the webhook in production.
  return 'pending';
}

export async function reconcilePayouts() {
  const processing = await prisma.payout.findMany({
    where: { status: 'processing' },
    select: { id: true, rzpTransferId: true },
  });
  let settled = 0;
  for (const p of processing) {
    const result = await settleProcessingPayout(p);
    if (result === 'paid' || result === 'failed') settled++;
  }
  return { processing: processing.length, settled };
}

// Handle a RazorpayX `payout.*` webhook event → paid(+utr) / failed(+reason).
export async function handlePayoutWebhook(event: {
  event: string;
  transferId: string;
  utr?: string;
  failureReason?: string;
}) {
  const payout = await prisma.payout.findFirst({ where: { rzpTransferId: event.transferId } });
  if (!payout) return { matched: false };

  const data: Prisma.PayoutUpdateInput = {};
  if (event.event.endsWith('processed') || event.event.endsWith('paid')) {
    data.status = 'paid';
    data.utr = event.utr ?? null;
    data.paidAt = new Date();
  } else if (event.event.endsWith('failed') || event.event.endsWith('reversed')) {
    data.status = 'failed';
    data.failureReason = event.failureReason ?? 'RazorpayX reported failure';
  } else {
    return { matched: true, applied: false };
  }
  await prisma.payout.update({ where: { id: payout.id }, data });
  return { matched: true, applied: true };
}

// ---------- Queries ----------

export function listPayouts(filter: { periodStart?: Date; status?: string }) {
  const where: Prisma.PayoutWhereInput = {};
  if (filter.periodStart) where.periodStart = filter.periodStart;
  if (filter.status) where.status = filter.status as Prisma.PayoutWhereInput['status'];
  return prisma.payout.findMany({ where, orderBy: [{ periodStart: 'desc' }, { netPaise: 'desc' }] });
}
