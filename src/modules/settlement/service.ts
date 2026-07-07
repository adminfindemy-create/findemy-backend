import * as repo from './repo.js';

// Accrue the rolling reserve on a captured payment. Called from the payment-capture webhook
// (inside its transaction). `reserveRateBps` should be the academy's configured rate.
export async function accrueReserveOnCapture(
  args: { academyId: string; grossPaise: number; sourceType: string; sourceId: string; reserveRateBps?: number; at?: Date },
  tx?: any,
) {
  return repo.createReserveHold(
    {
      academyId: args.academyId,
      amountPaise: args.grossPaise,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      reserveRateBps: args.reserveRateBps,
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

  const holds = await repo.getAvailableHolds(args.academyId);
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
    academyId: args.academyId,
    grossPaise: R,
    reserveAppliedPaise: reserveApplied,
    negativePaise: negative,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
  });

  return { reserve_applied_paise: reserveApplied, negative_paise: negative };
}

export async function getSettlement(academyId: string) {
  const s = await repo.getReserveSummary(academyId);
  return {
    reserve_rate_bps: 1000,
    reserve_held_paise: s.reserve_held_paise,
    reserve_released_paise: s.reserve_released_paise,
    // What the academy owes Findemy (netted from future payouts).
    outstanding_recovery_paise: s.outstanding_recovery_paise,
  };
}

export async function releaseMaturedReserve(now = new Date()) {
  return repo.releaseMaturedReserve(now);
}
