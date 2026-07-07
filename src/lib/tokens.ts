import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import type { webcrypto } from 'node:crypto';

const PRIVATE_KEY_PEM = process.env.JWT_PRIVATE_KEY || '';
const PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY || '';

let privateKey: webcrypto.CryptoKey | undefined;
let publicKey: webcrypto.CryptoKey | undefined;

async function getPrivateKey(): Promise<webcrypto.CryptoKey> {
  if (privateKey) return privateKey;
  privateKey = await importPKCS8(PRIVATE_KEY_PEM, 'ES256');
  return privateKey;
}

async function getPublicKey(): Promise<webcrypto.CryptoKey> {
  if (publicKey) return publicKey;
  publicKey = await importSPKI(PUBLIC_KEY_PEM, 'ES256');
  return publicKey;
}

// Simple helpers because jose doesn't expose importPKCS8 directly in all environments
async function importPKCS8(pem: string, _alg: string): Promise<webcrypto.CryptoKey> {
  const cleaned = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace('-----BEGIN EC PRIVATE KEY-----', '')
    .replace('-----END EC PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = Buffer.from(cleaned, 'base64');
  return crypto.subtle.importKey(
    'pkcs8',
    binary,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
}

async function importSPKI(pem: string, _alg: string): Promise<webcrypto.CryptoKey> {
  const cleaned = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');
  const binary = Buffer.from(cleaned, 'base64');
  return crypto.subtle.importKey(
    'spki',
    binary,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

export async function signAccessToken(payload: {
  sub: string;
  role: string;
  academy_id?: string;
}): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<{
  sub: string;
  role: string;
  academy_id?: string;
}> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, {
    clockTolerance: 60,
    maxTokenAge: '15m',
  });
  return {
    sub: String(payload.sub),
    role: String(payload.role),
    academy_id: payload.academy_id
      ? String(payload.academy_id)
      : undefined,
  };
}

// S3.2: short-lived, session-scoped check-in token embedded in the academy's QR.
// It only proves "this is today's session for batch X" — the student's identity comes
// from their auth on /attendance/checkin, so a leaked QR still only marks the scanner.
export async function signCheckinToken(payload: { batch_id: string; session_date: string }): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ kind: 'checkin', ...payload })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuedAt()
    .setExpirationTime('4h')
    .sign(key);
}

export async function verifyCheckinToken(token: string): Promise<{ batch_id: string; session_date: string }> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, { clockTolerance: 60, maxTokenAge: '4h' });
  if (payload.kind !== 'checkin') throw new Error('not a check-in token');
  return { batch_id: String(payload.batch_id), session_date: String(payload.session_date) };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
