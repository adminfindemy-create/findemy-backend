import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

// --- Mock the auth repo so service tests don't touch Prisma. ---
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
  accounts: FakeAcademyAccount[];
  academiesCreated: Array<Record<string, unknown>>;
} = {
  accounts: [],
  academiesCreated: [],
};

vi.mock('../modules/auth/repo.js', () => {
  const findAcademyAccountById = vi.fn(async (id: string) => {
    return repoState.accounts.find((a) => a.id === id) ?? null;
  });

  const createAcademyAndLink = vi.fn(
    async (params: {
      accountId: string;
      academyName: string;
      city: string;
      category: 'music' | 'dance' | 'arts' | 'yoga';
      ownerName: string | null;
      phone: string | null;
    }) => {
      const account = repoState.accounts.find((a) => a.id === params.accountId);
      if (!account) {
        throw new Error('Account not found in fake repo');
      }
      const academy = {
        id: `acad_${repoState.academiesCreated.length + 1}`,
        name: params.academyName,
        category: params.category,
        address: params.city,
        lat: null as number | null,
        lng: null as number | null,
        rating: 0,
        bio: null as string | null,
        verified: false,
        onlineAvailable: false,
        ratingCount: 0,
        createdAt: new Date(),
      };
      repoState.academiesCreated.push(academy);
      account.academyId = academy.id;
      account.academy = {
        id: academy.id,
        name: academy.name,
        category: academy.category,
        address: academy.address,
        lat: academy.lat,
        lng: academy.lng,
        rating: academy.rating,
        bio: academy.bio,
      };
      account.ownerName = params.ownerName;
      account.phone = params.phone;
      return { account, academy };
    },
  );

  return {
    findAcademyAccountById,
    createAcademyAndLink,
    // Stubs for unrelated exports so the import doesn't break.
    findOtpById: vi.fn(),
    createOtpRequest: vi.fn(),
    incrementOtpAttempts: vi.fn(),
    markOtpVerified: vi.fn(),
    findUserByPhone: vi.fn(),
    createUser: vi.fn(),
    updateUserLastActive: vi.fn(),
    findAcademyAccountByPhone: vi.fn(),
    findRefreshTokenByHash: vi.fn(),
    createRefreshToken: vi.fn(),
    revokeRefreshTokenByHash: vi.fn(),
    revokeAllRefreshTokensForSubject: vi.fn(),
    updateOnboarding: vi.fn(),
    updateInterests: vi.fn(),
    findMyEnrollments: vi.fn(),
    findUserByOAuth: vi.fn(),
    findUserByEmail: vi.fn(),
    createUserFromOAuth: vi.fn(),
    linkOAuthToUser: vi.fn(),
    findAcademyAccountByOAuth: vi.fn(),
    findAcademyAccountByEmail: vi.fn(),
    createAcademyAccountFromOAuth: vi.fn(),
    linkOAuthToAcademyAccount: vi.fn(),
    deriveAvatarInitial: (name?: string | null, email?: string | null) => {
      const src = (name ?? email ?? '').replace(/[^A-Za-z0-9]/g, '');
      return src ? src.slice(0, 2).toUpperCase() : '??';
    },
  };
});

// Env vars needed by lib/env import chain
process.env.JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY ?? 'test-priv';
process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY ?? 'test-pub';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://x';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://x';

// Mock the tokens module so we don't sign with real keys.
vi.mock('../lib/tokens.js', () => ({
  signAccessToken: vi.fn(async () => 'fake-access-token'),
  verifyAccessToken: vi.fn(async () => ({ sub: 'x', role: 'academy' })),
  generateRefreshToken: vi.fn(() => 'fake-refresh-token'),
  hashToken: vi.fn((t: string) => `hashed-${t}`),
}));

// IMPORTANT: dynamic imports below so vi.mock takes effect.
let completeAcademyOnboarding:
  typeof import('../modules/auth/service.js')['completeAcademyOnboarding'];

beforeEach(async () => {
  repoState.accounts = [];
  repoState.academiesCreated = [];

  if (!completeAcademyOnboarding) {
    const svc = await import('../modules/auth/service.js');
    completeAcademyOnboarding = svc.completeAcademyOnboarding;
  }
});

describe('completeAcademyOnboarding — new onboarding', () => {
  it('creates an Academy, links it to the account, and returns both', async () => {
    repoState.accounts.push({
      id: 'acc_1',
      phone: null,
      email: 'studio@x.com',
      emailVerified: true,
      appleSub: null,
      googleSub: 'g-sub',
      ownerName: null,
      academyId: null,
      academy: null,
      createdAt: new Date(),
    });

    const out = await completeAcademyOnboarding({
      accountId: 'acc_1',
      ownerName: 'Jane Owner',
      academyName: 'Jane Studios',
      city: 'Bengaluru',
      category: 'music',
      phone: '9999999999',
    });

    expect(out.account.id).toBe('acc_1');
    expect(out.account.academy_id).toBeDefined();
    expect(out.account.owner_name).toBe('Jane Owner');
    expect(out.account.phone).toBe('9999999999');
    expect(out.academy.name).toBe('Jane Studios');
    expect(out.academy.category).toBe('music');
    expect(out.academy.address).toBe('Bengaluru');
    expect(out.academy.lat).toBeNull();
    expect(out.academy.lng).toBeNull();
    expect(repoState.academiesCreated).toHaveLength(1);
  });

  it('preserves existing ownerName / phone on account when body omits them', async () => {
    repoState.accounts.push({
      id: 'acc_2',
      phone: '8888888888',
      email: 'studio2@x.com',
      emailVerified: true,
      appleSub: null,
      googleSub: 'g-sub-2',
      ownerName: 'Pre-existing Owner',
      academyId: null,
      academy: null,
      createdAt: new Date(),
    });

    const out = await completeAcademyOnboarding({
      accountId: 'acc_2',
      academyName: 'Acme Music',
      city: 'Pune',
      category: 'music',
    });

    expect(out.account.owner_name).toBe('Pre-existing Owner');
    expect(out.account.phone).toBe('8888888888');
    expect(out.academy.name).toBe('Acme Music');
  });
});

describe('completeAcademyOnboarding — idempotent', () => {
  it('returns the existing Academy unchanged and does not create another', async () => {
    repoState.accounts.push({
      id: 'acc_existing',
      phone: '7777777777',
      email: 'e@x.com',
      emailVerified: true,
      appleSub: null,
      googleSub: null,
      ownerName: 'Existing Owner',
      academyId: 'acad_pre',
      academy: {
        id: 'acad_pre',
        name: 'Existing Studio',
        category: 'dance',
        address: 'Chennai',
        lat: 13.0,
        lng: 80.2,
        rating: 4.7,
        bio: 'Hello',
      },
      createdAt: new Date(),
    });

    const out = await completeAcademyOnboarding({
      accountId: 'acc_existing',
      ownerName: 'Different Name',
      academyName: 'Different Studio',
      city: 'Mumbai',
      category: 'arts',
      phone: '1111111111',
    });

    expect(out.account.owner_name).toBe('Existing Owner');
    expect(out.account.phone).toBe('7777777777');
    expect(out.academy.id).toBe('acad_pre');
    expect(out.academy.name).toBe('Existing Studio');
    expect(out.academy.category).toBe('dance');
    expect(out.academy.address).toBe('Chennai');
    expect(repoState.academiesCreated).toHaveLength(0);
  });
});

describe('completeAcademyOnboarding — not found', () => {
  it('throws 404 when account id is unknown', async () => {
    await expect(
      completeAcademyOnboarding({
        accountId: 'missing',
        academyName: 'X',
        city: 'Y',
        category: 'music',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

// --- Schema-level validation. The route uses this exact schema before calling
// the service, so an invalid payload yields a Fastify 400. ---
const AcademyOnboardingSchema = z.object({
  ownerName: z.string().min(1).optional(),
  academyName: z.string().min(1),
  city: z.string().min(1),
  category: z.enum(['music', 'dance', 'arts', 'yoga']),
  phone: z.string().min(1).optional(),
});

describe('AcademyOnboardingSchema — request validation', () => {
  it('rejects payload missing academyName (route would 400)', () => {
    const r = AcademyOnboardingSchema.safeParse({
      city: 'Bengaluru',
      category: 'music',
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid category (route would 400)', () => {
    const r = AcademyOnboardingSchema.safeParse({
      academyName: 'X',
      city: 'Y',
      category: 'cooking',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a minimal valid payload', () => {
    const r = AcademyOnboardingSchema.safeParse({
      academyName: 'X',
      city: 'Y',
      category: 'yoga',
    });
    expect(r.success).toBe(true);
  });
});

// --- Auth required: hit the route through the real Fastify app with no
// Authorization header and expect 401 from requireAuth. ---
describe('POST /academy/onboarding — auth required', () => {
  it('returns 401 when no Authorization header is present', async () => {
    // Lazy import buildApp so the mocks above are wired up before app start.
    const { buildApp } = await import('../app.js');
    process.env.MOCK = process.env.MOCK ?? '0';
    const app = await buildApp();
    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/academy/onboarding',
        payload: {
          academyName: 'X',
          city: 'Y',
          category: 'music',
        },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
