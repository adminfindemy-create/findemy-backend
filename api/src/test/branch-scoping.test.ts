import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Branch resolution in `requireAuth('academy')` — the one place that decides which branch a
 * request acts on. Everything downstream (~30 studio routes) reads `req.user.academy_id`
 * without taking a branch parameter, so a mistake here is a cross-brand data leak rather than
 * a visible bug. See ai-usage/final-app/plan/academy-multi-branch.md §4.
 */

const db = {
  accounts: [] as { id: string; groupId: string | null; defaultAcademyId: string | null }[],
  branches: [] as { id: string; groupId: string; createdAt: Date }[],
};

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    academyAccount: {
      findUnique: vi.fn(async ({ where }: any) => db.accounts.find((a) => a.id === where.id) ?? null),
    },
    academy: {
      findUnique: vi.fn(async ({ where }: any) => db.branches.find((b) => b.id === where.id) ?? null),
      findMany: vi.fn(async ({ where, take }: any) => {
        const rows = db.branches
          .filter((b) => b.groupId === where.groupId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return take ? rows.slice(0, take) : rows;
      }),
    },
    adminUser: { findUnique: vi.fn() },
  },
}));

const verifyAccessToken = vi.fn();
vi.mock('../lib/tokens.js', () => ({ verifyAccessToken: (t: string) => verifyAccessToken(t) }));

const { authPlugin } = await import('../plugins/auth.js');

/** Run the real `requireAuth` decorator against a fake request. */
async function runAuth(headers: Record<string, string | string[]>) {
  let requireAuth: any;
  const app: any = {
    decorate: (name: string, fn: any) => {
      if (name === 'requireAuth') requireAuth = fn;
    },
  };
  await (authPlugin as any)(app, {});
  const req: any = { headers, user: undefined };
  await requireAuth('academy')(req);
  return req.user;
}

const AUTH = { authorization: 'Bearer token' };

beforeEach(() => {
  db.accounts = [
    { id: 'acc_1', groupId: 'grp_1', defaultAcademyId: null },
  ];
  db.branches = [
    { id: 'br_1', groupId: 'grp_1', createdAt: new Date('2026-01-01') },
    { id: 'br_2', groupId: 'grp_1', createdAt: new Date('2026-02-01') },
    { id: 'other_1', groupId: 'grp_other', createdAt: new Date('2026-01-01') },
  ];
  verifyAccessToken.mockResolvedValue({ sub: 'acc_1', role: 'academy', group_id: 'grp_1' });
});

describe('requireAuth("academy") — branch resolution', () => {
  it('honours a valid X-Branch-Id', async () => {
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_2' });
    expect(user.group_id).toBe('grp_1');
    expect(user.academy_id).toBe('br_2');
  });

  it('403s on a branch from another group — never a silent fallback to the default', async () => {
    // Silently serving the default branch here would hand back the wrong roster under a
    // request that explicitly asked for someone else's branch.
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'other_1' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('403s on an X-Branch-Id that does not exist', async () => {
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'nope' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('falls back to the account default when the header is absent', async () => {
    db.accounts[0].defaultAcademyId = 'br_2';
    const user = await runAuth(AUTH);
    expect(user.academy_id).toBe('br_2');
  });

  it('resolves a single-branch group to that branch — the pre-multi-branch behaviour', async () => {
    db.branches = [{ id: 'only', groupId: 'grp_1', createdAt: new Date('2026-01-01') }];
    const user = await runAuth(AUTH);
    expect(user.academy_id).toBe('only');
  });

  it('lands on the oldest branch when multi-branch with no default set', async () => {
    const user = await runAuth(AUTH);
    expect(user.academy_id).toBe('br_1');
  });

  it('prefers the DB group over a stale token claim', async () => {
    // An account moved to another brand must not keep acting on the old one for the
    // remaining life of its 15-minute access token.
    db.accounts[0].groupId = 'grp_other';
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'other_1' });
    expect(user.group_id).toBe('grp_other');
    expect(user.academy_id).toBe('other_1');
    // ...and the OLD group's branches are now forbidden.
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'br_1' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('leaves an un-onboarded account branchless instead of guessing', async () => {
    db.accounts[0].groupId = null;
    verifyAccessToken.mockResolvedValue({ sub: 'acc_1', role: 'academy' });
    const user = await runAuth(AUTH);
    expect(user.group_id).toBeUndefined();
    expect(user.academy_id).toBeUndefined();
  });

  it('403s when the account no longer exists', async () => {
    db.accounts = [];
    await expect(runAuth(AUTH)).rejects.toMatchObject({ status: 403 });
  });
});
