import { COMMISSION_BPS } from '../config.js';

// S2.4: Findemy's commission, computed from the captured gross. Taken from the academy
// payout — NEVER added to the learner's price. Same floor() rounding as enrolment pricing.
export function computeCommission(grossPaise: number): { commissionBps: number; commissionPaise: number } {
  const commissionBps = COMMISSION_BPS;
  const commissionPaise = Math.floor((grossPaise * commissionBps) / 10000);
  return { commissionBps, commissionPaise };
}

/** Proportional reversal when part/all of the gross is refunded. */
export function computeReversal(commissionPaise: number, grossPaise: number, refundPaise: number): number {
  if (grossPaise <= 0) return 0;
  return Math.floor((commissionPaise * Math.min(refundPaise, grossPaise)) / grossPaise);
}
