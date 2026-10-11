import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens.js';
import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { loadStaffGrants, ownerGrants, type EffectiveGrants } from '../lib/permission-resolver.js';
import type { PermissionKey } from '../lib/permissions.js';

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorate(
    'requireAuth',
    (role?: 'student' | 'academy', permission?: PermissionKey) =>
      async (req: FastifyRequest) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
          throw new AppError('UNAUTHORIZED', 401, 'Missing token');
        }
        const token = header.slice(7);
        let payload: { sub: string; role: string; sub_kind?: 'owner' | 'staff'; group_id?: string };
        try {
          payload = await verifyAccessToken(token);
        } catch {
          throw new AppError('UNAUTHORIZED', 401, 'Invalid token');
        }

        // 1. Authenticate.
        if (role && payload.role !== role) {
          throw new AppError('FORBIDDEN', 403, 'Role mismatch');
        }

        req.user = {
          id: payload.sub,
          role: payload.role as 'student' | 'academy',
        };

        if (payload.role !== 'academy') return;

        // 2. Authorize subject → group. Kept a SEPARATE step from the branch resolution below:
        //    `group_id` must never become an authorization shortcut. This is the seam the
        //    branch-scope table was reserved for, and it now holds it — `StaffBranchScope`,
        //    reached through the subject's role assignments.
        //
        //    `sub_kind` selects WHICH TABLE `sub` points at, never what is allowed. Both kinds
        //    mint `role: 'academy'`, so the ~77 handlers below are untouched.
        const isStaff = payload.sub_kind === 'staff';
        req.user.sub_kind = isStaff ? 'staff' : 'owner';

        let groupId: string | null | undefined;
        let defaultAcademyId: string | null = null;
        let grants: EffectiveGrants;

        if (isStaff) {
          const staff = await prisma.staffAccount.findUnique({
            where: { id: payload.sub },
            select: { id: true, groupId: true, status: true },
          });
          if (!staff) {
            throw new AppError('FORBIDDEN', 403, 'Staff account not found');
          }
          // Fail CLOSED on a deactivated account, mirroring requireAdmin's per-request
          // allowlist reload: a still-valid 15-minute access token must not outlive the
          // revocation. Hiding the account in the UI is not the control.
          if (staff.status !== 'active') {
            throw new AppError('FORBIDDEN', 403, 'Staff account is not active');
          }
          groupId = staff.groupId;
          grants = await loadStaffGrants(staff.id);
        } else {
          const account = await prisma.academyAccount.findUnique({
            where: { id: payload.sub },
            select: { id: true, groupId: true, defaultAcademyId: true },
          });
          if (!account) {
            throw new AppError('FORBIDDEN', 403, 'Academy account not found');
          }
          groupId = account.groupId;
          defaultAcademyId = account.defaultAcademyId;
          grants = ownerGrants();
        }

        req.user.perms_map = grants.perms;
        req.user.coach_ids = grants.coachIds;
        req.user.allowed_branch_ids = grants.branchIds;

        // Prefer the DB over the token: a subject whose group changed mid-session must not
        // keep acting on the old brand until its 15-minute access token expires.
        groupId = groupId ?? payload.group_id;
        req.user.group_id = groupId ?? undefined;

        // A login with no group has not onboarded yet — routes handle the absent-academy
        // state exactly as they did before (route to onboarding). Only an OWNER can be in
        // this state: a StaffAccount is always created against an existing brand.
        if (!groupId) {
          assertPermission(req, permission);
          return;
        }

        // 3. Resolve the effective branch.
        const requested = req.headers['x-branch-id'];
        const branchId = Array.isArray(requested) ? requested[0] : requested;
        // undefined = the whole group (an owner). A staff subject always has an explicit list.
        const allowed = grants.branchIds;

        if (branchId) {
          const branch = await prisma.academy.findUnique({
            where: { id: branchId },
            select: { id: true, groupId: true },
          });
          // Never fall back to the default on a bad header: silently serving another
          // branch's roster is worse than an error the client can act on.
          if (!branch || branch.groupId !== groupId) {
            throw new AppError('BRANCH_FORBIDDEN', 403, 'Branch not in your academy group');
          }
          // 3a. Same rule one level in: a header naming a real branch of this brand that this
          //     SUBJECT does not hold is equally a 403, and equally never a silent fallback.
          if (allowed && !allowed.includes(branch.id)) {
            throw new AppError('BRANCH_FORBIDDEN', 403, 'Branch not in your access scope');
          }
          req.user.academy_id = branch.id;
          assertPermission(req, permission);
          return;
        }

        if (defaultAcademyId && (!allowed || allowed.includes(defaultAcademyId))) {
          req.user.academy_id = defaultAcademyId;
          assertPermission(req, permission);
          return;
        }

        if (allowed) {
          // A staff subject never falls back to "the group's branches": its candidate set is
          // exactly the branches it holds. Zero of them is a server-side misconfiguration —
          // the session resolves no branch and every branch-grained route will 404, which the
          // client turns into a logout rather than an empty studio.
          if (allowed.length > 0) {
            // Oldest-first, so a subject with several branches lands deterministically on the
            // same one every session rather than on whatever Postgres returned first.
            const branches = await prisma.academy.findMany({
              where: { id: { in: allowed }, groupId },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            });
            if (branches.length === 1) req.user.academy_id = branches[0].id;
          }
          assertPermission(req, permission);
          return;
        }

        // Single-branch group (the overwhelmingly common case): that branch IS the answer,
        // so a client that never sends the header behaves exactly as it did before.
        const branches = await prisma.academy.findMany({
          where: { groupId },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: 2,
        });
        if (branches.length === 1) {
          req.user.academy_id = branches[0].id;
        } else if (branches.length > 1) {
          // Multi-branch with no default set — land on the oldest branch rather than
          // leaving the session branchless.
          req.user.academy_id = branches[0].id;
        }

        assertPermission(req, permission);
      },
  );

  // Student discovery reads (academies, programs, workshops, events, search, availability) are
  // open to guests so the app can be browsed before signing up. No header → anonymous, and
  // `req.user` stays unset. A header that IS sent is still verified and must be a student's: an
  // expired token has to 401 so the client refreshes it, rather than silently getting the
  // anonymous (un-personalised) payload.
  app.decorate('optionalStudentAuth', () => async (req: FastifyRequest) => {
    if (!req.headers.authorization) return;
    await app.requireAuth('student')(req);
  });

  // Ops Console guard. Verifies the JWT, asserts role === 'admin', then (re)loads the
  // AdminUser allowlist row on every request so a disabled/removed admin is locked out
  // immediately even while holding a still-valid access token. `perm` is accepted for
  // future RBAC but not enforced yet (single admin role).
  app.decorate(
    'requireAdmin',
    (_perm?: string) =>
      async (req: FastifyRequest) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
          throw new AppError('UNAUTHORIZED', 401, 'Missing token');
        }
        const token = header.slice(7);
        let payload: { sub: string; role: string; perms?: string[] };
        try {
          payload = await verifyAccessToken(token);
        } catch {
          throw new AppError('UNAUTHORIZED', 401, 'Invalid token');
        }

        if (payload.role !== 'admin') {
          throw new AppError('FORBIDDEN', 403, 'Admin only');
        }

        const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
        if (!admin || admin.disabled) {
          throw new AppError('FORBIDDEN', 403, 'Admin not found or disabled');
        }

        req.user = {
          id: admin.id,
          role: 'admin',
          adminId: admin.id,
          perms: payload.perms,
        };
      },
  );
});

// 4. Enforce the route's permission key, if it declared one.
//
// Called at every exit of step 3 rather than once at the end, because those exits are early
// `return`s. A missed call would silently un-guard a route, so the shape to preserve is
// "every path out of the academy branch ends in exactly one assertPermission".
function assertPermission(req: FastifyRequest, permission?: PermissionKey): void {
  if (!permission) return;
  if (!req.user.perms_map?.has(permission)) {
    throw new AppError('FORBIDDEN', 403, 'You do not have permission to do that');
  }
}
