import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mock `jose` so we can drive verifier behavior in tests. ---
// We control jwtVerify per-test via `joseMock.payload` / `joseMock.error`.

type JosePayload = Record<string, unknown>;
const joseMock: { payload: JosePayload | null; error: unknown } = {
  payload: null,
  error: null,
};

class FakeJWTExpired extends Error {
  code = 'ERR_JWT_EXPIRED';
}
class FakeJWTClaimValidationFailed extends Error {
  code = 'ERR_JWT_CLAIM_VALIDATION_FAILED';
  claim: string;
  constructor(message: string, claim: string) {
    super(message);
    this.claim = claim;
  }
}
class FakeJWKSNoMatchingKey extends Error {
  code = 'ERR_JWKS_NO_MATCHING_KEY';
}
class FakeJWKSMultipleMatchingKeys extends Error {
  code = 'ERR_JWKS_MULTIPLE_MATCHING_KEYS';
}
class FakeJWKSInvalid extends Error {
  code = 'ERR_JWKS_INVALID';
}
class FakeJWKSTimeout extends Error {
  code = 'ERR_JWKS_TIMEOUT';
}

vi.mock('jose', () => {
  return {
    createRemoteJWKSet: () => () => Promise.resolve({ type: 'fake-key' }),
    jwtVerify: vi.fn(async (_token: string, _key: unknown, _opts: unknown) => {
      if (joseMock.error) throw joseMock.error;
      return { payload: joseMock.payload ?? {} };
    }),
    errors: {
      JWTExpired: FakeJWTExpired,
      JWTClaimValidationFailed: FakeJWTClaimValidationFailed,
      JWKSNoMatchingKey: FakeJWKSNoMatchingKey,
      JWKSMultipleMatchingKeys: FakeJWKSMultipleMatchingKeys,
      JWKSInvalid: FakeJWKSInvalid,
      JWKSTimeout: FakeJWKSTimeout,
    },
  };
});

// --- Mock the auth repo so service tests don't touch Prisma. ---
type FakeUser = {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  age: number | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  interests: string[];
  avatarInitial: string;
  attendanceOtp: string;
  appleSub: string | null;
  googleSub: string | null;
  createdAt: Date;
  lastActiveAt: Date;
};

type FakeAcademyAccount = {
  id: string;
  phone: string | null;
  email: string | null;
  emailVerified: boolean;
  appleSub: string | null;
  googleSub: string | null;
  ownerName: string | null;
  academyId: string | null;
  academy: null | {
    id: string;
    name: string;
    category: string;
    address: string;
    lat: number | null;
    lng: number | null;
    rating: number;
    bio: string | null;
  };
  createdAt: Date;
};

const repoState: {
  users: FakeUser[];
  accounts: FakeAcademyAccount[];
  refreshTokens: Array<Record<string, unknown>>;
} = {
  users: [],
  accounts: [],
  refreshTokens: [],
};

vi.mock('../modules/auth/repo.js', () => {
  const findUserByOAuth = vi.fn(async (provider: 'apple' | 'google', sub: string) => {
    const col = provider === 'apple' ? 'appleSub' : 'googleSub';
    return repoState.users.find((u) => (u as any)[col] === sub) ?? null;
  });
  const findUserByEmail = vi.fn(async (email: string) => {
    return repoState.users.find((u) => u.email === email) ?? null;
  });
  const createUserFromOAuth = vi.fn(async (params: any) => {
    const u: FakeUser = {
      id: `user_${repoState.users.length + 1}`,
      phone: null,
      email: params.email ?? null,
      name: params.name ?? null,
      age: null,
      location: null,
      lat: null,
      lng: null,
      interests: [],
      avatarInitial: 'XX',
      attendanceOtp: params.attendanceOtp,
      appleSub: params.provider === 'apple' ? params.sub : null,
      googleSub: params.provider === 'google' ? params.sub : null,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };
    repoState.users.push(u);
    return u;
  });
  const linkOAuthToUser = vi.fn(async (userId: string, provider: 'apple' | 'google', sub: string) => {
    const u = repoState.users.find((x) => x.id === userId)!;
    if (provider === 'apple') u.appleSub = sub;
    else u.googleSub = sub;
    return u;
  });
  const updateUserLastActive = vi.fn(async (id: string) => {
    const u = repoState.users.find((x) => x.id === id);
    if (u) u.lastActiveAt = new Date();
    return u;
  });

  const findAcademyAccountByOAuth = vi.fn(async (provider: 'apple' | 'google', sub: string) => {
    const col = provider === 'apple' ? 'appleSub' : 'googleSub';
    return repoState.accounts.find((a) => (a as any)[col] === sub) ?? null;
  });
  const findAcademyAccountByEmail = vi.fn(async (email: string) => {
    return repoState.accounts.find((a) => a.email === email) ?? null;
  });
  const createAcademyAccountFromOAuth = vi.fn(async (params: any) => {
    const a: FakeAcademyAccount = {
      id: `acc_${repoState.accounts.length + 1}`,
      phone: null,
      email: params.email ?? null,
      emailVerified: !!params.emailVerified,
      appleSub: params.provider === 'apple' ? params.sub : null,
      googleSub: params.provider === 'google' ? params.sub : null,
      ownerName: params.name ?? null,
      academyId: null,
      academy: null,
      createdAt: new Date(),
    };
    repoState.accounts.push(a);
    return a;
  });
  const linkOAuthToAcademyAccount = vi.fn(
    async (accountId: string, provider: 'apple' | 'google', sub: string) => {
      const a = repoState.accounts.find((x) => x.id === accountId)!;
      if (provider === 'apple') a.appleSub = sub;
      else a.googleSub = sub;
      return a;
    },
  );

  const createRefreshToken = vi.fn(async (rt: any) => {
    repoState.refreshTokens.push(rt);
    return rt;
  });

  return {
    findUserByOAuth,
    findUserByEmail,
    createUserFromOAuth,
    linkOAuthToUser,
    updateUserLastActive,
    findAcademyAccountByOAuth,
    findAcademyAccountByEmail,
    createAcademyAccountFromOAuth,
    linkOAuthToAcademyAccount,
    createRefreshToken,
    // Stubs for unrelated exports so the import doesn't break for sibling code paths
    findOtpById: vi.fn(),
    createOtpRequest: vi.fn(),
    incrementOtpAttempts: vi.fn(),
    markOtpVerified: vi.fn(),
    findUserByPhone: vi.fn(),
    createUser: vi.fn(),
    findAcademyAccountByPhone: vi.fn(),
    findRefreshTokenByHash: vi.fn(),
    revokeRefreshTokenByHash: vi.fn(),
    revokeAllRefreshTokensForSubject: vi.fn(),
    updateOnboarding: vi.fn(),
    updateInterests: vi.fn(),
    findMyEnrollments: vi.fn(),
    findAcademyAccountById: vi.fn(),
    deriveAvatarInitial: (name?: string | null, email?: string | null) => {
      const src = (name ?? email ?? '').replace(/[^A-Za-z0-9]/g, '');
      return src ? src.slice(0, 2).toUpperCase() : '??';
    },
  };
});

// Set the env vars the verifiers need BEFORE importing service / env.
process.env.JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY ?? 'test-priv';
process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY ?? 'test-pub';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://x';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://x';
process.env.APPLE_STUDENT_BUNDLE_ID = 'app.findemy.student';
process.env.APPLE_ADMIN_BUNDLE_ID = 'app.findemy.admin';
process.env.GOOGLE_STUDENT_IOS_CLIENT_ID = 'student-ios.apps.googleusercontent.com';
process.env.GOOGLE_STUDENT_ANDROID_CLIENT_ID = 'student-android.apps.googleusercontent.com';
process.env.GOOGLE_ADMIN_IOS_CLIENT_ID = 'admin-ios.apps.googleusercontent.com';
process.env.GOOGLE_ADMIN_ANDROID_CLIENT_ID = 'admin-android.apps.googleusercontent.com';

// Mock the tokens module to avoid signing with real keys.
vi.mock('../lib/tokens.js', () => ({
  signAccessToken: vi.fn(async () => 'fake-access-token'),
  verifyAccessToken: vi.fn(async () => ({ sub: 'x', role: 'student' })),
  generateRefreshToken: vi.fn(() => 'fake-refresh-token'),
  hashToken: vi.fn((t: string) => `hashed-${t}`),
}));

// IMPORTANT: dynamic imports below so vi.mock takes effect.
let loginWithOAuth: typeof import('../modules/auth/service.js')['loginWithOAuth'];
let verifyApple: typeof import('../modules/auth/oauth/apple-verifier.js')['verifyApple'];
let verifyGoogle: typeof import('../modules/auth/oauth/google-verifier.js')['verifyGoogle'];

beforeEach(async () => {
  // Reset state
  repoState.users = [];
  repoState.accounts = [];
  repoState.refreshTokens = [];
  joseMock.payload = null;
  joseMock.error = null;

  if (!loginWithOAuth) {
    const svc = await import('../modules/auth/service.js');
    loginWithOAuth = svc.loginWithOAuth;
    const a = await import('../modules/auth/oauth/apple-verifier.js');
    verifyApple = a.verifyApple;
    const g = await import('../modules/auth/oauth/google-verifier.js');
    verifyGoogle = g.verifyGoogle;
  }
});

import { createHash } from 'crypto';
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Apple verifier', () => {
  it('rejects expired token with oauth_expired', async () => {
    joseMock.error = new FakeJWTExpired('exp');
    await expect(
      verifyApple({
        idToken: 't',
        bundleId: 'app.findemy.student',
      }),
    ).rejects.toMatchObject({ code: 'oauth_expired', status: 401 });
  });

  it('rejects bad audience with oauth_audience_mismatch', async () => {
    joseMock.error = new FakeJWTClaimValidationFailed('aud', 'aud');
    await expect(
      verifyApple({ idToken: 't', bundleId: 'app.findemy.student' }),
    ).rejects.toMatchObject({ code: 'oauth_audience_mismatch', status: 401 });
  });

  it('rejects nonce mismatch with oauth_nonce_mismatch', async () => {
    joseMock.payload = { sub: 'apple-sub-1', nonce: sha256Hex('expected') };
    await expect(
      verifyApple({
        idToken: 't',
        bundleId: 'app.findemy.student',
        nonce: 'wrong',
      }),
    ).rejects.toMatchObject({ code: 'oauth_nonce_mismatch', status: 401 });
  });

  it('returns profile on valid token', async () => {
    joseMock.payload = {
      sub: 'apple-sub-1',
      email: 'a@b.com',
      email_verified: true,
      nonce: sha256Hex('raw'),
    };
    const profile = await verifyApple({
      idToken: 't',
      bundleId: 'app.findemy.student',
      nonce: 'raw',
    });
    expect(profile).toMatchObject({
      sub: 'apple-sub-1',
      email: 'a@b.com',
      emailVerified: true,
    });
  });
});

describe('Google verifier', () => {
  it('rejects expired token', async () => {
    joseMock.error = new FakeJWTExpired('exp');
    await expect(
      verifyGoogle({
        idToken: 't',
        allowedAudiences: ['client-id'],
      }),
    ).rejects.toMatchObject({ code: 'oauth_expired', status: 401 });
  });

  it('rejects bad audience', async () => {
    joseMock.error = new FakeJWTClaimValidationFailed('aud', 'aud');
    await expect(
      verifyGoogle({ idToken: 't', allowedAudiences: ['client-id'] }),
    ).rejects.toMatchObject({ code: 'oauth_audience_mismatch', status: 401 });
  });

  it('returns profile on valid token', async () => {
    joseMock.payload = {
      sub: 'google-sub-1',
      email: 'g@b.com',
      email_verified: true,
      name: 'Gee Bee',
    };
    const profile = await verifyGoogle({
      idToken: 't',
      allowedAudiences: ['client-id'],
    });
    expect(profile).toMatchObject({
      sub: 'google-sub-1',
      email: 'g@b.com',
      emailVerified: true,
      name: 'Gee Bee',
    });
  });
});

describe('loginWithOAuth — student / Apple', () => {
  it('creates a new user for an unknown apple sub', async () => {
    joseMock.payload = {
      sub: 'apple-new',
      email: 'new@x.com',
      email_verified: true,
      nonce: sha256Hex('raw'),
    };
    const out = await loginWithOAuth({
      provider: 'apple',
      idToken: 't',
      nonce: 'raw',
      role: 'student',
    });
    expect(out.is_new_user).toBe(true);
    expect(out.access_token).toBeDefined();
    expect(out.refresh_token).toBeDefined();
    expect(out.user).toBeDefined();
    expect(repoState.users).toHaveLength(1);
    expect(repoState.users[0].appleSub).toBe('apple-new');
  });

  it('returns the same user for a known apple sub', async () => {
    repoState.users.push({
      id: 'user_existing',
      phone: null,
      email: 'existing@x.com',
      name: 'Existing',
      age: null,
      location: null,
      lat: null,
      lng: null,
      interests: [],
      avatarInitial: 'EX',
      attendanceOtp: '000000',
      appleSub: 'apple-known',
      googleSub: null,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    joseMock.payload = { sub: 'apple-known', email: 'existing@x.com', email_verified: true };
    const out = await loginWithOAuth({
      provider: 'apple',
      idToken: 't',
      role: 'student',
    });
    expect(out.is_new_user).toBe(false);
    expect((out.user as any).id).toBe('user_existing');
  });

  it('links apple sub to existing user found by email', async () => {
    repoState.users.push({
      id: 'user_byemail',
      phone: '9999999999',
      email: 'link@x.com',
      name: 'Linkable',
      age: null,
      location: null,
      lat: null,
      lng: null,
      interests: [],
      avatarInitial: 'LI',
      attendanceOtp: '000000',
      appleSub: null,
      googleSub: null,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    joseMock.payload = { sub: 'apple-link', email: 'link@x.com', email_verified: true };
    const out = await loginWithOAuth({
      provider: 'apple',
      idToken: 't',
      role: 'student',
    });
    expect(out.is_new_user).toBe(false);
    expect((out.user as any).id).toBe('user_byemail');
    expect(repoState.users[0].appleSub).toBe('apple-link');
  });

  it('surfaces oauth_expired from verifier', async () => {
    joseMock.error = new FakeJWTExpired('exp');
    await expect(
      loginWithOAuth({ provider: 'apple', idToken: 't', role: 'student' }),
    ).rejects.toMatchObject({ code: 'oauth_expired' });
  });

  it('surfaces oauth_audience_mismatch from verifier', async () => {
    joseMock.error = new FakeJWTClaimValidationFailed('aud', 'aud');
    await expect(
      loginWithOAuth({ provider: 'apple', idToken: 't', role: 'student' }),
    ).rejects.toMatchObject({ code: 'oauth_audience_mismatch' });
  });

  it('surfaces oauth_nonce_mismatch from verifier', async () => {
    joseMock.payload = { sub: 'apple-x', nonce: sha256Hex('expected') };
    await expect(
      loginWithOAuth({
        provider: 'apple',
        idToken: 't',
        nonce: 'wrong',
        role: 'student',
      }),
    ).rejects.toMatchObject({ code: 'oauth_nonce_mismatch' });
  });
});

describe('loginWithOAuth — student / Google', () => {
  it('creates a new user for unknown google sub', async () => {
    joseMock.payload = {
      sub: 'google-new',
      email: 'gnew@x.com',
      email_verified: true,
      name: 'Goo',
    };
    const out = await loginWithOAuth({
      provider: 'google',
      idToken: 't',
      role: 'student',
    });
    expect(out.is_new_user).toBe(true);
    expect((out.user as any).id).toBeDefined();
    expect(repoState.users[0].googleSub).toBe('google-new');
  });

  it('returns existing user by google sub', async () => {
    repoState.users.push({
      id: 'user_g',
      phone: null,
      email: 'g@x.com',
      name: 'G',
      age: null,
      location: null,
      lat: null,
      lng: null,
      interests: [],
      avatarInitial: 'G',
      attendanceOtp: '000000',
      appleSub: null,
      googleSub: 'google-known',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    joseMock.payload = { sub: 'google-known', email: 'g@x.com', email_verified: true };
    const out = await loginWithOAuth({
      provider: 'google',
      idToken: 't',
      role: 'student',
    });
    expect(out.is_new_user).toBe(false);
    expect((out.user as any).id).toBe('user_g');
  });

  it('surfaces oauth_audience_mismatch', async () => {
    joseMock.error = new FakeJWTClaimValidationFailed('aud', 'aud');
    await expect(
      loginWithOAuth({ provider: 'google', idToken: 't', role: 'student' }),
    ).rejects.toMatchObject({ code: 'oauth_audience_mismatch' });
  });
});

describe('loginWithOAuth — academy', () => {
  it('creates a new academy account with academy=null and is_new_user=true', async () => {
    joseMock.payload = {
      sub: 'apple-acad-new',
      email: 'studio@x.com',
      email_verified: true,
    };
    const out = await loginWithOAuth({
      provider: 'apple',
      idToken: 't',
      role: 'academy',
    });
    expect(out.is_new_user).toBe(true);
    expect(out.account).toBeDefined();
    expect((out.account as any).academy_id).toBeNull();
    expect(out.academy).toBeNull();
    expect(repoState.accounts).toHaveLength(1);
  });

  it('returns existing account by apple sub with envelope shape', async () => {
    repoState.accounts.push({
      id: 'acc_existing',
      phone: '9999',
      email: 'studio@x.com',
      emailVerified: true,
      appleSub: 'apple-acad-known',
      googleSub: null,
      ownerName: 'Owner',
      academyId: 'acad_1',
      academy: {
        id: 'acad_1',
        name: 'Studio',
        category: 'music',
        address: 'Addr',
        lat: 12.9,
        lng: 77.6,
        rating: 4.5,
        bio: null,
      },
      createdAt: new Date(),
    });
    joseMock.payload = {
      sub: 'apple-acad-known',
      email: 'studio@x.com',
      email_verified: true,
    };
    const out = await loginWithOAuth({
      provider: 'apple',
      idToken: 't',
      role: 'academy',
    });
    expect(out.is_new_user).toBe(false);
    expect((out.account as any).id).toBe('acc_existing');
    expect(out.academy).toBeDefined();
    expect((out.academy as any).id).toBe('acad_1');
  });
});
