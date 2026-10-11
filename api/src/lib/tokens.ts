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
  // Which TABLE `sub` points at for an academy-side token: 'owner' -> AcademyAccount,
  // 'staff' -> StaffAccount. The `role` claim stays 'academy' for both, because it names the
  // AUDIENCE ("academy-side"), not the privilege level — which is what keeps the ~77 existing
  // academy handlers and their `req.user.academy_id` reads untouched.
  //
  // ABSENT means 'owner', so every token minted before staff logins shipped keeps working.
  sub_kind?: 'owner' | 'staff';
  // Academy tokens carry the BRAND, not a branch. The active branch is resolved per request
  // from the `X-Branch-Id` header (see plugins/auth.ts) so tapping the branch switcher never
  // needs a token re-mint and cross-branch rollups need no sequential token swaps.
  group_id?: string;
  // Admin RBAC scaffolding: plumbed into the token but not enforced yet (single admin role).
  //
  // NOTE academy-side permissions are deliberately NOT here. They are loaded per request from
  // the DB so that revoking a role takes effect at once rather than after the 15-minute access
  // token expires — the same reason this file's sibling `plugins/auth.ts` already prefers the
  // DB over the token for `groupId`.
  perms?: string[];
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
  sub_kind?: 'owner' | 'staff';
  group_id?: string;
  perms?: string[];
}> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, {
    clockTolerance: 60,
    maxTokenAge: '15m',
  });
  return {
    sub: String(payload.sub),
    role: String(payload.role),
    // Anything other than an explicit 'staff' is an owner, including the absent claim on
    // tokens minted before staff logins existed.
    sub_kind: payload.sub_kind === 'staff' ? 'staff' : 'owner',
    group_id: payload.group_id
      ? String(payload.group_id)
      : undefined,
    perms: Array.isArray(payload.perms)
      ? (payload.perms as unknown[]).map(String)
      : undefined,
  };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
