import { describe, it, expect } from 'vitest';
import { PAUSE_WEEKS_PER_PERIOD, pauseDurationsForPlan } from '@findemy/types';
import {
  countClassOccurrences,
  pauseAllowanceWeeks,
  pauseDurationDays,
  pauseWeeksForDuration,
} from '../lib/pause.js';

// Pause allowance is per PAID PERIOD (owner decision 2026-09-05): monthly 1 week, quarterly 2,
// quarterly's splittable into two 1-week pauses. Durations are whole weeks so that extending the
// period by 7 × weeks re-delivers exactly the weekdays that were skipped.

const MWF = [
  { dayOfWeek: 1, startTime: '17:00' },
  { dayOfWeek: 3, startTime: '17:00' },
  { dayOfWeek: 5, startTime: '17:00' },
];
const SAT_ONLY = [{ dayOfWeek: 6, startTime: '10:00' }];

/** IST midnight for a plain date — pause windows are day-scale facts. */
const ist = (d: string) => new Date(`${d}T00:00:00.000+05:30`);

describe('pause allowance', () => {
  it('gives monthly one week and quarterly two, per period', () => {
    expect(pauseAllowanceWeeks('monthly')).toBe(1);
    expect(pauseAllowanceWeeks('quarterly')).toBe(2);
  });

  it('never scales an allowance past quarterly', () => {
    const max = PAUSE_WEEKS_PER_PERIOD.quarterly;
    for (const weeks of Object.values(PAUSE_WEEKS_PER_PERIOD)) {
      expect(weeks).toBeLessThanOrEqual(max);
    }
  });

  it('offers monthly only the 1-week option, quarterly both', () => {
    expect(pauseDurationsForPlan('monthly')).toEqual(['one_week']);
    expect(pauseDurationsForPlan('quarterly')).toEqual(['one_week', 'two_weeks']);
  });

  it('rejects a retired or unknown duration rather than defaulting it', () => {
    expect(pauseWeeksForDuration('one_month')).toBeNull();
    expect(pauseDurationDays('one_month')).toBeNull();
    expect(pauseWeeksForDuration('garbage')).toBeNull();
  });

  it('converts durations to whole weeks of days', () => {
    expect(pauseDurationDays('one_week')).toBe(7);
    expect(pauseDurationDays('two_weeks')).toBe(14);
  });
});

describe('countClassOccurrences', () => {
  it('counts a full week of a thrice-weekly batch', () => {
    // Mon 7 Sep 2026 → Mon 14 Sep: Mon 7, Wed 9, Fri 11.
    expect(countClassOccurrences(MWF, ist('2026-09-07'), ist('2026-09-14'))).toBe(3);
  });

  it('counts double for a two-week pause', () => {
    expect(countClassOccurrences(MWF, ist('2026-09-07'), ist('2026-09-21'))).toBe(6);
  });

  it('is independent of which weekday the window opens on', () => {
    // The make-good identity the whole design rests on: any 7-day window over a weekly schedule
    // contains exactly one week of classes, so a 7-day period extension repays the pause exactly.
    for (let offset = 0; offset < 7; offset++) {
      const from = new Date(ist('2026-09-07').getTime() + offset * 86400000);
      const to = new Date(from.getTime() + 7 * 86400000);
      expect(countClassOccurrences(MWF, from, to)).toBe(3);
      expect(countClassOccurrences(SAT_ONLY, from, to)).toBe(1);
    }
  });

  it('counts only the classes actually missed when a student resumes early', () => {
    // Paused Mon 7 Sep, resumed Thu 10 Sep → missed Mon 7 and Wed 9, not Fri 11.
    expect(countClassOccurrences(MWF, ist('2026-09-07'), ist('2026-09-10'))).toBe(2);
  });

  it('excludes the closing instant so back-to-back windows never double-count', () => {
    const a = countClassOccurrences(MWF, ist('2026-09-07'), ist('2026-09-14'));
    const b = countClassOccurrences(MWF, ist('2026-09-14'), ist('2026-09-21'));
    expect(a + b).toBe(countClassOccurrences(MWF, ist('2026-09-07'), ist('2026-09-21')));
  });

  it('returns zero for an empty or inverted window, and for a batch with no timings', () => {
    expect(countClassOccurrences(MWF, ist('2026-09-07'), ist('2026-09-07'))).toBe(0);
    expect(countClassOccurrences(MWF, ist('2026-09-14'), ist('2026-09-07'))).toBe(0);
    expect(countClassOccurrences([], ist('2026-09-07'), ist('2026-09-14'))).toBe(0);
  });
});
