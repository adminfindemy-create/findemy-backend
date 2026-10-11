import { describe, it, expect } from 'vitest';
import { isExpectedOn, type ExpectationEnrollment } from '../lib/attendance-expectation.js';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const base: ExpectationEnrollment = {
  userId: 'u1',
  learnerId: 'l1',
  startedAt: day('2026-07-01'),
  discontinueRequestedAt: null,
  periods: [{ startDate: day('2026-07-01'), endDate: day('2026-07-31'), discontinueEffectiveAt: null }],
  pauses: [],
};

describe('who is expected at a session', () => {
  it('expects a student inside their paid period', () => {
    expect(isExpectedOn(base, day('2026-07-15'))).toBe(true);
  });

  // A student who joined on the 20th must not show a month of red.
  it('does not expect a student before they enrolled', () => {
    const joinedLate = { ...base, startedAt: day('2026-07-20'), periods: [{ startDate: day('2026-07-20'), endDate: day('2026-08-19'), discontinueEffectiveAt: null }] };
    expect(isExpectedOn(joinedLate, day('2026-07-15'))).toBe(false);
    expect(isExpectedOn(joinedLate, day('2026-07-20'))).toBe(true);
  });

  it('does not expect a session outside every paid period', () => {
    expect(isExpectedOn(base, day('2026-08-05'))).toBe(false);
  });

  // A paused student's % must not keep falling while their fees are on hold.
  it('does not expect a paused student', () => {
    const paused = { ...base, pauses: [{ startDate: day('2026-07-10'), endDate: day('2026-07-17') }] };
    expect(isExpectedOn(paused, day('2026-07-12'))).toBe(false);
    expect(isExpectedOn(paused, day('2026-07-18'))).toBe(true);
  });

  // A leaver keeps the sessions they were enrolled for — that's why a past month still shows why
  // they left — but nothing after the day they left.
  it('expects a leaver up to the day they left, and no further', () => {
    const left = {
      ...base,
      discontinueRequestedAt: day('2026-07-18'),
      periods: [{ startDate: day('2026-07-01'), endDate: day('2026-07-31'), discontinueEffectiveAt: day('2026-07-18') }],
    };
    expect(isExpectedOn(left, day('2026-07-10'))).toBe(true);
    expect(isExpectedOn(left, day('2026-07-18'))).toBe(true);
    expect(isExpectedOn(left, day('2026-07-19'))).toBe(false);
  });
});
