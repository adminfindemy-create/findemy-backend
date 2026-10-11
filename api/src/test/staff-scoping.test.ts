import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * RBAC in `requireAuth('academy', permission)` — identity, branch scope, and the permission
 * check. Everything downstream reads `req.user.academy_id` and `req.user.perms_map` without
 * re-checking, so a mistake here is a privilege escalation or a cross-brand leak rather than a
 * visible bug. See ai-usage/final-app/plan/academy-staff-roles.md §4.
 *
 * ⚠️ These drive the REAL decorator against a mocked `../lib/prisma.js`, deliberately NOT a
 * `getTestApp()` helper under `MOCK=1`: `plugins/mock.ts` registers an app-level `preHandler`
 * that short-circuits before any route-level guard runs, so a suite passing under mock mode
 * would prove nothing at all about authorization.
 */

type Grant = { permission: string; scope: 'academy' | 'branch' | 'assigned'; deny: boolean };
type Assignment = { coachId: string | null; branches: { academyId: string }[]; permissions: Grant[] };

const db = {
  accounts: [] as { id: string; groupId: string | null; defaultAcademyId: string | null }[],
  staff: [] as { id: string; groupId: string; status: string }[],
  assignments: {} as Record<string, Assignment[]>,
  branches: [] as { id: string; groupId: string; createdAt: Date }[],
};

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    academyAccount: {
      findUnique: vi.fn(async ({ where }: any) => db.accounts.find((a) => a.id === where.id) ?? null),
    },
    staffAccount: {
      findUnique: vi.fn(async ({ where }: any) => db.staff.find((s) => s.id === where.id) ?? null),
    },
    staffRoleAssignment: {
      findMany: vi.fn(async ({ where }: any) =>
        (db.assignments[where.staffId] ?? []).map((a) => ({
          coachId: a.coachId,
          branches: a.branches,
          role: { permissions: a.permissions },
        })),
      ),
    },
    academy: {
      findUnique: vi.fn(async ({ where }: any) => db.branches.find((b) => b.id === where.id) ?? null),
      findMany: vi.fn(async ({ where, take }: any) => {
        const rows = db.branches
          .filter((b) => b.groupId === where.groupId)
          .filter((b) => (where.id?.in ? where.id.in.includes(b.id) : true))
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
const { PERMISSION_KEYS, ROLE_MATRIX, isReserved } = await import('../lib/permissions.js');

async function runAuth(headers: Record<string, string | string[]>, permission?: string) {
  let requireAuth: any;
  const app: any = {
    decorate: (name: string, fn: any) => {
      if (name === 'requireAuth') requireAuth = fn;
    },
  };
  await (authPlugin as any)(app, {});
  const req: any = { headers, user: undefined };
  await requireAuth('academy', permission)(req);
  return req.user;
}

const AUTH = { authorization: 'Bearer token' };
const asStaff = (id: string) =>
  verifyAccessToken.mockResolvedValue({ sub: id, role: 'academy', sub_kind: 'staff', group_id: 'grp_1' });
const asOwner = () =>
  verifyAccessToken.mockResolvedValue({ sub: 'acc_1', role: 'academy', sub_kind: 'owner', group_id: 'grp_1' });

/** Build the grant rows a seeded role would produce, straight from the catalogue. */
function grantsFor(role: 'manager' | 'teacher'): Grant[] {
  const m = ROLE_MATRIX[role] as Record<string, { scope: any; deny?: true }>;
  return Object.keys(m).map((permission) => ({
    permission,
    scope: m[permission]!.scope,
    deny: m[permission]!.deny ?? false,
  }));
}

beforeEach(() => {
  db.accounts = [{ id: 'acc_1', groupId: 'grp_1', defaultAcademyId: null }];
  db.branches = [
    { id: 'br_1', groupId: 'grp_1', createdAt: new Date('2026-01-01') },
    { id: 'br_2', groupId: 'grp_1', createdAt: new Date('2026-02-01') },
    { id: 'other_1', groupId: 'grp_other', createdAt: new Date('2026-01-01') },
  ];
  db.staff = [
    { id: 'stf_mgr', groupId: 'grp_1', status: 'active' },
    { id: 'stf_tch', groupId: 'grp_1', status: 'active' },
    { id: 'stf_off', groupId: 'grp_1', status: 'deactivated' },
    { id: 'stf_both', groupId: 'grp_1', status: 'active' },
    { id: 'stf_nobranch', groupId: 'grp_1', status: 'active' },
  ];
  db.assignments = {
    // Manager at br_1 only. br_2 is what proves the scope excludes something.
    stf_mgr: [{ coachId: null, branches: [{ academyId: 'br_1' }], permissions: grantsFor('manager') }],
    stf_tch: [{ coachId: 'coach_1', branches: [{ academyId: 'br_1' }], permissions: grantsFor('teacher') }],
    stf_off: [{ coachId: null, branches: [{ academyId: 'br_1' }], permissions: grantsFor('manager') }],
    stf_both: [
      { coachId: null, branches: [{ academyId: 'br_1' }], permissions: grantsFor('manager') },
      { coachId: 'coach_1', branches: [{ academyId: 'br_1' }], permissions: grantsFor('teacher') },
    ],
    stf_nobranch: [{ coachId: null, branches: [], permissions: grantsFor('manager') }],
  };
  asOwner();
});

describe('identity', () => {
  it('an owner token still resolves exactly as before, and holds every permission', async () => {
    const user = await runAuth(AUTH);
    expect(user.sub_kind).toBe('owner');
    expect(user.group_id).toBe('grp_1');
    expect(user.allowed_branch_ids).toBeUndefined(); // undefined = the whole group
    for (const k of PERMISSION_KEYS) expect(user.perms_map.get(k)).toBe('academy');
  });

  it('a staff token resolves against StaffAccount, not AcademyAccount', async () => {
    asStaff('stf_mgr');
    const user = await runAuth(AUTH);
    expect(user.sub_kind).toBe('staff');
    expect(user.group_id).toBe('grp_1');
    expect(user.allowed_branch_ids).toEqual(['br_1']);
  });

  it('a deactivated staff account fails CLOSED even with a valid unexpired token', async () => {
    asStaff('stf_off');
    await expect(runAuth(AUTH)).rejects.toMatchObject({ status: 403 });
  });

  it('an unknown staff id is a 403, never an auto-created account', async () => {
    asStaff('stf_ghost');
    await expect(runAuth(AUTH)).rejects.toMatchObject({ status: 403 });
  });
});

describe('branch scope', () => {
  it('honours an in-scope X-Branch-Id', async () => {
    asStaff('stf_mgr');
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_1' });
    expect(user.academy_id).toBe('br_1');
  });

  it('403s on a real sibling branch outside scope — and never falls back to one in scope', async () => {
    asStaff('stf_mgr');
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'br_2' })).rejects.toMatchObject({
      status: 403,
      code: 'BRANCH_FORBIDDEN',
    });
  });

  it('403s on another brand’s branch with the same repairable code', async () => {
    asStaff('stf_mgr');
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'other_1' })).rejects.toMatchObject({
      status: 403,
      code: 'BRANCH_FORBIDDEN',
    });
  });

  it('with no header, lands on an IN-SCOPE branch — never the group’s oldest if out of scope', async () => {
    db.assignments.stf_mgr = [
      { coachId: null, branches: [{ academyId: 'br_2' }], permissions: grantsFor('manager') },
    ];
    asStaff('stf_mgr');
    const user = await runAuth(AUTH);
    // br_1 is the group's oldest branch and would be the owner's fallback. It must not be his.
    expect(user.academy_id).toBe('br_2');
  });

  it('a staff account with zero branches resolves NO branch rather than the group’s first', async () => {
    asStaff('stf_nobranch');
    const user = await runAuth(AUTH);
    expect(user.allowed_branch_ids).toEqual([]);
    expect(user.academy_id).toBeUndefined();
  });

  it('an owner is still unrestricted across the brand', async () => {
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_2' });
    expect(user.academy_id).toBe('br_2');
  });
});

describe('permission enforcement', () => {
  const OWNER_ONLY = [
    'earnings.view',
    'finance.kyc',
    'staff.manage',
    'branches.create',
    // A manager may create and EDIT programs; only deleting one is the owner's, because a
    // delete is brand-wide, permanent, and takes the program's batches with it.
    'programs.delete',
    'settings.brand.edit',
    'batches.delete',
    'batches.discontinue',
    'audit.view',
  ] as const;

  for (const key of OWNER_ONLY) {
    it(`manager is denied ${key}`, async () => {
      asStaff('stf_mgr');
      await expect(runAuth({ ...AUTH, 'x-branch-id': 'br_1' }, key)).rejects.toMatchObject({ status: 403 });
    });
  }

  it('manager IS allowed the day-to-day keys', async () => {
    asStaff('stf_mgr');
    for (const key of ['batches.manage', 'students.view', 'attendance.view', 'reviews.respond']) {
      const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_1' }, key);
      expect(user.perms_map.get(key)).toBe('branch');
    }
  });

  it('manager may create and edit programs, at academy scope', async () => {
    // ACADEMY scope is forced, not chosen: `Program` hangs off `groupId` and has no `academyId`,
    // so a branch-scoped write would have nothing to filter on.
    asStaff('stf_mgr');
    for (const key of ['programs.create', 'programs.edit']) {
      const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_1' }, key);
      expect(user.perms_map.get(key)).toBe('academy');
    }
  });

  it('an owner passes every enforced key', async () => {
    for (const key of PERMISSION_KEYS.filter((k) => !isReserved(k))) {
      await expect(runAuth(AUTH, key)).resolves.toBeTruthy();
    }
  });

  it('a route with no permission key stays open to any academy principal', async () => {
    asStaff('stf_tch');
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'br_1' })).resolves.toBeTruthy();
  });
});

describe('refunds — the live money denial', () => {
  it('a manager is denied refunds.issue by an explicit deny row', async () => {
    asStaff('stf_mgr');
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'br_1' }, 'refunds.issue')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('DENY beats a grant from ANY other assignment, whichever loaded first', async () => {
    // The future-custom-role case decision 4's union would otherwise silently allow.
    db.assignments.stf_mgr = [
      {
        coachId: null,
        branches: [{ academyId: 'br_1' }],
        permissions: [{ permission: 'refunds.issue', scope: 'academy', deny: false }],
      },
      ...db.assignments.stf_mgr,
    ];
    asStaff('stf_mgr');
    await expect(runAuth({ ...AUTH, 'x-branch-id': 'br_1' }, 'refunds.issue')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('an owner may issue a refund', async () => {
    const user = await runAuth(AUTH, 'refunds.issue');
    expect(user.perms_map.get('refunds.issue')).toBe('academy');
  });
});

describe('union across assignments', () => {
  it('widens to the broadest scope: manager + teacher yields branch, not assigned', async () => {
    asStaff('stf_both');
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_1' }, 'students.view');
    expect(user.perms_map.get('students.view')).toBe('branch');
  });

  it('still carries the teacher’s coach ids, so the assigned scope is not lost', async () => {
    asStaff('stf_both');
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_1' });
    expect(user.coach_ids).toEqual(['coach_1']);
  });

  it('a teacher alone gets assigned scope and their coach id', async () => {
    asStaff('stf_tch');
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_1' }, 'students.view');
    expect(user.perms_map.get('students.view')).toBe('assigned');
    expect(user.coach_ids).toEqual(['coach_1']);
  });

  it('a teacher with no coach link has an EMPTY assigned scope, never an absent filter', async () => {
    db.assignments.stf_tch = [
      { coachId: null, branches: [{ academyId: 'br_1' }], permissions: grantsFor('teacher') },
    ];
    asStaff('stf_tch');
    const user = await runAuth({ ...AUTH, 'x-branch-id': 'br_1' });
    expect(user.coach_ids).toEqual([]);
  });
});

describe('catalogue integrity', () => {
  it('no reserved key is held by any non-owner role', async () => {
    for (const role of ['manager', 'teacher'] as const) {
      for (const key of Object.keys(ROLE_MATRIX[role])) {
        if (isReserved(key as never)) {
          expect((ROLE_MATRIX[role] as any)[key]?.deny).toBe(true);
        }
      }
    }
  });

  it('the owner role covers every key in the catalogue', () => {
    for (const key of PERMISSION_KEYS) expect(ROLE_MATRIX.owner[key]).toBeTruthy();
  });
});

describe('one person, one record', () => {
  it('the invite contract carries no coach_id', async () => {
    // The `THIS TEACHER IS` picker asked the owner to reconcile two rows describing one human.
    // A teacher's Coach is now created server-side alongside their login, so if this field ever
    // comes back, the duplicate-person bug comes back with it.
    const { readFileSync } = await import('node:fs');
    const routes = readFileSync(
      new URL('../modules/staff/routes.ts', import.meta.url),
      'utf-8',
    );
    // Matches it as a FIELD (`coach_id:`), not as a word — the file explains in prose why the
    // field is gone, and that explanation should not fail its own test.
    expect(routes).not.toMatch(/\bcoach_id\s*:/);
  });

  it('a teacher assignment is the only thing that may hold a coach', () => {
    // Managers hold none; the schema's @unique is what stops two logins claiming one coach.
    const teacher = ROLE_MATRIX.teacher as Record<string, unknown>;
    const manager = ROLE_MATRIX.manager as Record<string, unknown>;
    expect('batches.view' in teacher).toBe(true);
    // A teacher still cannot browse the brand's coach directory — they are one of the people
    // in it, they do not administer it.
    expect('coaches.view' in teacher).toBe(false);
    expect('coaches.manage' in teacher).toBe(false);
    expect('coaches.manage' in manager).toBe(true);
  });
});
