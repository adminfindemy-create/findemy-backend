import { describe, it, expect } from 'vitest';
import { serializeTrial } from '../modules/trials/service.js';

// A fabricated row shaped like the Prisma include in repo.findTrialsByUser.
// We cast to the serializer's parameter type because we only populate the
// fields the serializer actually reads.
function makeTrialRow(overrides: Record<string, unknown> = {}) {
  const trialAt = new Date('2026-07-01T10:30:00.000Z');
  return {
    id: 'trial-1',
    userId: 'user-1',
    academyId: 'academy-1',
    batchId: 'batch-1',
    slotId: 'slot-1',
    bookingId: 'booking-1',
    trialAt,
    status: 'booked',
    attendanceMarkedAt: null,
    attendanceMarkedByAccountId: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    academy: { name: 'Raaga Music', address: '12 MG Road' },
    batch: {
      title: 'Guitar · Beginner',
      category: 'music',
      trialFeePaise: 0,
      coach: { name: 'Asha Rao' },
    },
    slot: { slotTime: trialAt },
    booking: {
      status: 'confirmed',
      rescheduleCount: 0,
      payment: { status: 'captured', amountPaise: 0, refundStatus: null },
    },
    ...overrides,
  } as unknown as Parameters<typeof serializeTrial>[0];
}

describe('serializeTrial', () => {
  it('emits trial_at as an ISO string (A1)', () => {
    const out = serializeTrial(makeTrialRow());
    expect(out.trial_at).toBe('2026-07-01T10:30:00.000Z');
    // It must NOT use the legacy scheduled_at key clients were drifting on.
    expect((out as Record<string, unknown>).scheduled_at).toBeUndefined();
  });

  it('emits coach_name from batch.coach.name (A2)', () => {
    const out = serializeTrial(makeTrialRow());
    expect(out.coach_name).toBe('Asha Rao');
  });

  it('emits coach_name as null when the coach relation is absent (A2)', () => {
    const out = serializeTrial(
      makeTrialRow({
        batch: { title: 'Guitar', category: 'music', trialFeePaise: 0 },
      }),
    );
    expect(out.coach_name).toBeNull();
  });

  it('mirrors a cancelled parent booking onto a still-booked trial', () => {
    const out = serializeTrial(
      makeTrialRow({
        status: 'booked',
        booking: {
          status: 'cancelled',
          rescheduleCount: 0,
          payment: { status: 'captured', amountPaise: 0, refundStatus: null },
        },
      }),
    );
    expect(out.status).toBe('cancelled');
  });
});
