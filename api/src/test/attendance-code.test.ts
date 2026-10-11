import { describe, it, expect } from 'vitest';
import { classCode, codesMatch, trialCode } from '../lib/attendance-code.js';

// Every class and every trial has its own code. These pin the properties the feature promises.
describe('attendance codes', () => {
  it('is 4 digits and stable for the same learner, batch and day', () => {
    const a = classCode('aarav', 'guitar', '2026-10-12');
    expect(a).toMatch(/^\d{4}$/);
    expect(classCode('aarav', 'guitar', '2026-10-12')).toBe(a);
  });

  it('changes from one class day to the next', () => {
    const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    const codes = new Set(days.map((d) => classCode('aarav', 'guitar', d)));
    expect(codes.size).toBeGreaterThan(1);
  });

  it('differs between siblings in the same class', () => {
    expect(classCode('aarav', 'guitar', '2026-10-12')).not.toBe(classCode('anaya', 'guitar', '2026-10-12'));
  });

  it('differs between two batches on the same day', () => {
    expect(classCode('aarav', 'guitar', '2026-10-12')).not.toBe(classCode('aarav', 'dance', '2026-10-12'));
  });

  it('differs between a trial and a class', () => {
    expect(trialCode('aarav', 't1')).not.toBe(trialCode('aarav', 't2'));
  });

  it('compares codes exactly', () => {
    expect(codesMatch('0420', '0420')).toBe(true);
    expect(codesMatch('0420', '420')).toBe(false);
    expect(codesMatch('0420', '0421')).toBe(false);
  });
});
