import { createHash } from 'crypto';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { AppError } from '../../../lib/app-error.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

// Cached at module scope — jose handles JWKS rotation/TTL internally.
const appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

export interface AppleProfile {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export interface VerifyAppleInput {
  idToken: string;
  nonce?: string;
  bundleId: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return false;
}

export async function verifyApple({
  idToken,
  nonce,
  bundleId,
}: VerifyAppleInput): Promise<AppleProfile> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(idToken, appleJwks, {
      issuer: APPLE_ISSUER,
      audience: bundleId,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AppError('oauth_expired', 401, 'Apple token expired');
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = (err as { claim?: string }).claim;
      if (claim === 'aud') {
        throw new AppError(
          'oauth_audience_mismatch',
          401,
          'Apple token audience mismatch',
        );
      }
      if (claim === 'iss') {
        throw new AppError(
          'oauth_issuer_mismatch',
          401,
          'Apple token issuer mismatch',
        );
      }
      throw new AppError(
        'oauth_invalid_token',
        401,
        'Apple token claim validation failed',
      );
    }
    if (
      err instanceof joseErrors.JWKSNoMatchingKey ||
      err instanceof joseErrors.JWKSMultipleMatchingKeys ||
      err instanceof joseErrors.JWKSInvalid ||
      err instanceof joseErrors.JWKSTimeout
    ) {
      throw new AppError(
        'oauth_provider_unreachable',
        502,
        'Apple JWKS unavailable',
      );
    }
    throw new AppError('oauth_invalid_token', 401, 'Apple token invalid');
  }

  // Nonce check (Apple-only). Apple stores the SHA-256 hex of the raw nonce.
  if (nonce !== undefined) {
    const expected = sha256Hex(nonce);
    const got = typeof payload.nonce === 'string' ? payload.nonce : undefined;
    if (!got || got !== expected) {
      throw new AppError(
        'oauth_nonce_mismatch',
        401,
        'Apple nonce mismatch',
      );
    }
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AppError('oauth_invalid_token', 401, 'Apple token missing sub');
  }

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const emailVerified = normalizeBool(payload.email_verified);

  // Apple does NOT include the user's name in the ID token. The full name
  // is delivered only once via the client-side Apple Sign-In response on
  // first sign-in. Callers should pass it separately if available.
  return { sub, email, emailVerified };
}
