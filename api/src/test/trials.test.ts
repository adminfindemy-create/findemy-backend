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

// The code is for the guardian's own reads only, only inside the trial's window (1 h before →
// 30 min after), and different for every trial. The academy verifies it and is never handed it.
describe('serializeTrial — attendance code', () => {
  const trialAt = new Date('2026-07-01T10:30:00.000Z');
  const withLearner = (overrides: Record<string, unknown> = {}) =>
    makeTrialRow({ learnerId: 'aarav', learner: { id: 'aarav', name: 'Aarav' }, trialAt, ...overrides });
  const at = (iso: string) => ({ withCode: true, now: new Date(iso) });

  it('names the learner on every read', () => {
    expect(serializeTrial(withLearner()).learner).toEqual({ id: 'aarav', name: 'Aarav' });
  });

  it('leaves the code out unless asked', () => {
    expect(serializeTrial(withLearner())).not.toHaveProperty('attendance_code');
  });

  it('gives a 4-digit code inside the window', () => {
    expect(serializeTrial(withLearner(), at('2026-07-01T10:00:00.000Z')).attendance_code).toMatch(/^\d{4}$/);
  });

  it('withholds the code before the window, and says when it opens', () => {
    const out = serializeTrial(withLearner(), at('2026-07-01T09:00:00.000Z'));
    expect(out.attendance_code).toBeNull();
    expect(out.attendance_code_opens_at).toBe('2026-07-01T09:30:00.000Z');
  });

  it('withholds the code after the window', () => {
    expect(serializeTrial(withLearner(), at('2026-07-01T11:01:00.000Z')).attendance_code).toBeNull();
  });

  it('withholds the code once the trial is no longer booked', () => {
    expect(serializeTrial(withLearner({ status: 'attended' }), at('2026-07-01T10:00:00.000Z')).attendance_code).toBeNull();
  });
});
