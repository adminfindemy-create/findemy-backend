import { describe, it, expect } from 'vitest';
import { computeNet, startOfWeekUTC, currentPeriod, previousPeriod } from './payout.js';

const MIN = 10000; // ₹100, passed explicitly so tests don't depend on env.

const base = {
  grossPaise: 0,
  commissionPaise: 0,
  reserveHeldPaise: 0,
  reserveReleasedPaise: 0,
  carriedInPaise: 0,
  outstandingRecoveryPaise: 0,
  minPayoutPaise: MIN,
};

describe('computeNet', () => {
  it('computes a standard weekly payout (captured − commission − reserve)', () => {
    // ₹3,200 enrolment: 15% commission = ₹480, 10% reserve = ₹320 → net ₹2,400.
    const r = computeNet({ ...base, grossPaise: 320000, commissionPaise: 48000, reserveHeldPaise: 32000 });
    expect(r.netPaise).toBe(240000);
    expect(r.status).toBe('pending');
    expect(r.recoveryAppliedPaise).toBe(0);
  });

  it('adds matured reserve released this period back into the net', () => {
    const r = computeNet({
      ...base,
      grossPaise: 100000,
      commissionPaise: 15000,
      reserveHeldPaise: 10000,
      reserveReleasedPaise: 25000,
    });
    // 100000 − 15000 − 10000 + 25000 = 100000
    expect(r.netPaise).toBe(100000);
    expect(r.status).toBe('pending');
  });

  it('skips a below-minimum positive net and carries it forward', () => {
    // net = 5000 (< ₹100 min) → skipped, nothing paid, amount preserved for carry-forward.
    const r = computeNet({ ...base, grossPaise: 8000, commissionPaise: 1200, reserveHeldPaise: 800 });
    expect(r.netPaise).toBe(6000);
    expect(r.status).toBe('skipped');
  });

  it('rolls a prior skipped balance in via carriedInPaise to clear the minimum', () => {
    // periodNet 6000 alone would skip; + 6000 carried in = 12000 ≥ min → pending.
    const r = computeNet({
      ...base,
      grossPaise: 8000,
      commissionPaise: 1200,
      reserveHeldPaise: 800,
      carriedInPaise: 6000,
    });
    expect(r.netPaise).toBe(12000);
    expect(r.status).toBe('pending');
  });

  it('nets outstanding recovery (negativePaise) from available funds', () => {
    // available 240000, owes 40000 → pay 200000, recovery fully applied.
    const r = computeNet({
      ...base,
      grossPaise: 320000,
      commissionPaise: 48000,
      reserveHeldPaise: 32000,
      outstandingRecoveryPaise: 40000,
    });
    expect(r.recoveryAppliedPaise).toBe(40000);
    expect(r.netPaise).toBe(200000);
    expect(r.status).toBe('pending');
  });

  it('partially applies recovery when the debt exceeds available funds (negative-balance carry-forward)', () => {
    // available 240000, owes 500000 → apply 240000 (never below 0), net 0 → skipped; remaining
    // 260000 debt stays outstanding for the next period.
    const r = computeNet({
      ...base,
      grossPaise: 320000,
      commissionPaise: 48000,
      reserveHeldPaise: 32000,
      outstandingRecoveryPaise: 500000,
    });
    expect(r.recoveryAppliedPaise).toBe(240000);
    expect(r.netPaise).toBe(0);
    expect(r.status).toBe('skipped');
  });

  it('does not apply recovery when there is nothing available (below-min available)', () => {
    // available 6000 < min → skip BEFORE touching recovery, so the debt is untouched.
    const r = computeNet({
      ...base,
      grossPaise: 8000,
      commissionPaise: 1200,
      reserveHeldPaise: 800,
      outstandingRecoveryPaise: 500000,
    });
    expect(r.recoveryAppliedPaise).toBe(0);
    expect(r.status).toBe('skipped');
  });

  it('handles a net-negative period (e.g. reserve accrual outweighs a tiny capture) as skipped', () => {
    const r = computeNet({ ...base, grossPaise: 1000, commissionPaise: 150, reserveHeldPaise: 100 });
    expect(r.netPaise).toBe(750);
    expect(r.status).toBe('skipped');
  });

  it('is deterministic across repeated computation (idempotent inputs → identical output)', () => {
    const inputs = { ...base, grossPaise: 320000, commissionPaise: 48000, reserveHeldPaise: 32000 };
    expect(computeNet(inputs)).toEqual(computeNet(inputs));
  });
});

describe('period helpers', () => {
  it('startOfWeekUTC returns Sunday 00:00:00 UTC', () => {
    // 2026-07-08 is a Wednesday → week starts Sunday 2026-07-05.
    const s = startOfWeekUTC(new Date('2026-07-08T13:45:00.000Z'));
    expect(s.toISOString()).toBe('2026-07-05T00:00:00.000Z');
    expect(s.getUTCDay()).toBe(0);
  });

  it('current and previous periods are contiguous, 7-day windows', () => {
    const now = new Date('2026-07-08T13:45:00.000Z');
    const cur = currentPeriod(now);
    const prev = previousPeriod(now);
    expect(prev.periodEnd.toISOString()).toBe(cur.periodStart.toISOString());
    expect(cur.periodEnd.getTime() - cur.periodStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(prev.periodEnd.getTime() - prev.periodStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
