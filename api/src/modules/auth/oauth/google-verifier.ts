import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { AppError } from '../../../lib/app-error.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = [
  'https://accounts.google.com',
  'accounts.google.com',
] as const;

// Cached at module scope — jose handles JWKS rotation/TTL internally.
const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export interface GoogleProfile {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  // Google Workspace hosted-domain claim; only present for Workspace accounts.
  // Used by the Ops Console admin path to restrict logins to the Findemy domain.
  hd?: string;
}

export interface VerifyGoogleInput {
  idToken: string;
  allowedAudiences: string[];
}

function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return false;
}

export async function verifyGoogle({
  idToken,
  allowedAudiences,
}: VerifyGoogleInput): Promise<GoogleProfile> {
  const audiences = allowedAudiences.filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (audiences.length === 0) {
    throw new AppError(
      'oauth_audience_mismatch',
      401,
      'No allowed Google client IDs configured',
    );
  }

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(idToken, googleJwks, {
      issuer: [...GOOGLE_ISSUERS],
      audience: audiences,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AppError('oauth_expired', 401, 'Google token expired');
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = (err as { claim?: string }).claim;
      if (claim === 'aud') {
        throw new AppError(
          'oauth_audience_mismatch',
          401,
          'Google token audience mismatch',
        );
      }
      if (claim === 'iss') {
        throw new AppError(
          'oauth_issuer_mismatch',
          401,
          'Google token issuer mismatch',
        );
      }
      throw new AppError(
        'oauth_invalid_token',
        401,
        'Google token claim validation failed',
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
        'Google JWKS unavailable',
      );
    }
    throw new AppError('oauth_invalid_token', 401, 'Google token invalid');
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AppError('oauth_invalid_token', 401, 'Google token missing sub');
  }

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const emailVerified = normalizeBool(payload.email_verified);
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const hd = typeof payload.hd === 'string' ? payload.hd : undefined;

  return { sub, email, emailVerified, name, hd };
}
