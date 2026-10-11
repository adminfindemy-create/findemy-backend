import { prisma } from '../../lib/prisma.js';
import * as repo from './repo.js';

// Callers across capture/refund naturally hold an Academy id — a BRANCH — but reserve and
// recovery are payee-grain now. One hop keeps every call site unchanged.
async function entityIdForBranch(academyId: string, tx?: any): Promise<string> {
  const db = tx ?? prisma;
  const branch = await db.academy.findUnique({
    where: { id: academyId },
    select: { financialEntityId: true },
  });
  if (!branch) throw new Error(`Unknown academy ${academyId} — cannot resolve financial entity`);
  return branch.financialEntityId;
}

// The entity's configured reserve rate. It moved off `Academy` with the rest of the payee
// fields, so two branches on one entity can no longer disagree about their own rate.
async function reserveRateForBranch(academyId: string, tx?: any): Promise<number | undefined> {
  const db = tx ?? prisma;
  const branch = await db.academy.findUnique({
    where: { id: academyId },
    select: { financialEntity: { select: { reserveRateBps: true } } },
  });
  return branch?.financialEntity?.reserveRateBps;
}

// Accrue the rolling reserve on a captured payment. Called from the payment-capture webhook
// (inside its transaction). `reserveRateBps` should be the academy's configured rate.
export async function accrueReserveOnCapture(
  args: { academyId: string; grossPaise: number; sourceType: string; sourceId: string; reserveRateBps?: number; at?: Date },
  tx?: any,
) {
  const financialEntityId = await entityIdForBranch(args.academyId, tx);
  return repo.createReserveHold(
    {
      financialEntityId,
      amountPaise: args.grossPaise,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      reserveRateBps: args.reserveRateBps ?? (await reserveRateForBranch(args.academyId, tx)),
      heldAt: args.at,
    },
    tx,
  );
}

// Recover a discontinuation refund from the academy (plan §9): the academy bears the FULL gross R.
// Draw from held reserve first (oldest first); the remainder becomes a negative balance netted
// from future payouts. Returns how R was split.
export async function applyRefundRecovery(args: {
  academyId: string;
  grossPaise: number;
  sourceType: string;
  sourceId: string;
}) {
  const R = args.grossPaise;
  if (R <= 0) {
    return { reserve_applied_paise: 0, negative_paise: 0 };
  }

  const financialEntityId = await entityIdForBranch(args.academyId);
  const holds = await repo.getAvailableHolds(financialEntityId);
  let remaining = R;
  let reserveApplied = 0;
  for (const h of holds) {
    if (remaining <= 0) break;
    const available = h.amountPaise - h.consumedPaise;
    if (available <= 0) continue;
    const draw = Math.min(available, remaining);
    const newConsumed = h.consumedPaise + draw;
    await repo.consumeHold(h.id, newConsumed, newConsumed >= h.amountPaise);
    reserveApplied += draw;
    remaining -= draw;
  }

  const negative = remaining; // uncovered by reserve → negative balance
  await repo.createRecovery({
    financialEntityId,
    grossPaise: R,
    reserveAppliedPaise: reserveApplied,
    negativePaise: negative,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
  });

  return { reserve_applied_paise: reserveApplied, negative_paise: negative };
}

// Settlement figures for the branch's PAYEE. Two branches sharing an entity therefore report
// the same reserve and the same outstanding recovery — which is the truth: there is one pot.
export async function getSettlement(academyId: string) {
  const financialEntityId = await entityIdForBranch(academyId);
  const [s, rate] = await Promise.all([
    repo.getReserveSummary(financialEntityId),
    reserveRateForBranch(academyId),
  ]);
  return {
    financial_entity_id: financialEntityId,
    reserve_rate_bps: rate ?? 1000,
    reserve_held_paise: s.reserve_held_paise,
    reserve_released_paise: s.reserve_released_paise,
    // What the academy owes Findemy (netted from future payouts).
    outstanding_recovery_paise: s.outstanding_recovery_paise,
  };
}

export async function releaseMaturedReserve(now = new Date()) {
  return repo.releaseMaturedReserve(now);
}
