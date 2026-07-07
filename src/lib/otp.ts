import { randomInt } from 'crypto';
import { createHash, timingSafeEqual } from 'crypto';
import { OTP_LOGIN_LENGTH, OTP_ATTENDANCE_LENGTH } from '@findemy/types';

function randomDigits(n: number): string {
  return String(randomInt(10 ** (n - 1), 10 ** n));
}

// S2.2: login OTP (phone verify) stays 6-digit; the trial attendance OTP is 4-digit.
// Two generators so shrinking the attendance code can never weaken login.
export function generateOtpCode(): string {
  return randomDigits(OTP_LOGIN_LENGTH);
}

export function generateAttendanceOtp(): string {
  return randomDigits(OTP_ATTENDANCE_LENGTH);
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function compareOtpHash(code: string, hash: string): boolean {
  const computed = hashOtp(code);
  const computedBuf = Buffer.from(computed, 'hex');
  const hashBuf = Buffer.from(hash, 'hex');
  if (computedBuf.length !== hashBuf.length) return false;
  return timingSafeEqual(computedBuf, hashBuf);
}
