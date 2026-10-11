import { describe, it, expect } from 'vitest';
import { istWallClockToUtc, istDateKey } from './ist.js';

describe('istWallClockToUtc', () => {
  it('maps an IST wall-clock to the correct UTC instant (offset -5:30)', () => {
    // 18:00 IST on 2026-06-10  ==  12:30 UTC on 2026-06-10
    const utc = istWallClockToUtc('2026-06-10', 18, 0);
    expect(utc.toISOString()).toBe('2026-06-10T12:30:00.000Z');
  });

  it('rolls back across UTC midnight for early IST wall-clocks', () => {
    // 02:00 IST on 2026-06-10  ==  20:30 UTC on 2026-06-09
    const utc = istWallClockToUtc('2026-06-10', 2, 0);
    expect(utc.toISOString()).toBe('2026-06-09T20:30:00.000Z');
  });

  it('is independent of the host machine timezone', () => {
    // No Date.setHours anywhere → result must not shift with process.env.TZ.
    const utc = istWallClockToUtc('2026-01-01', 9, 30);
    expect(utc.toISOString()).toBe('2026-01-01T04:00:00.000Z');
  });
});

describe('istDateKey', () => {
  it('returns the IST calendar date of a UTC instant', () => {
    // 20:30 UTC == 02:00 IST next day → IST date is the 11th
    expect(istDateKey(new Date('2026-06-10T20:30:00.000Z'))).toBe('2026-06-11');
  });

  it('keeps the same date for a midday IST instant', () => {
    expect(istDateKey(new Date('2026-06-10T12:30:00.000Z'))).toBe('2026-06-10');
  });

  it('round-trips with istWallClockToUtc', () => {
    const utc = istWallClockToUtc('2026-12-31', 23, 45);
    expect(istDateKey(utc)).toBe('2026-12-31');
  });
});
