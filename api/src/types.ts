import type { PermissionKey, PermissionScope } from './lib/permissions.js';

export interface AuthUser {
  id: string;
  role: 'student' | 'academy' | 'admin';
  // Which TABLE `id` points at for an academy-side request. 'owner' -> AcademyAccount (the
  // pre-existing behaviour), 'staff' -> StaffAccount. `role` stays 'academy' for both, so the
  // 77 existing academy guards and the ~60 `academy_id` reads are untouched.
  // See ai-usage/final-app/plan/academy-staff-roles.md §2.
  sub_kind?: 'owner' | 'staff';
  // The brand an academy login belongs to. Authorization is decided against THIS, never
  // against `academy_id` — see plugins/auth.ts.
  group_id?: string;
  // The EFFECTIVE branch for this request: `X-Branch-Id` (validated against `group_id` AND,
  // for staff, against `allowed_branch_ids`), else the account's `defaultAcademyId`, else the
  // group's only branch. Routes keep reading this exactly as they did when one login meant
  // one academy.
  academy_id?: string;
  // Effective permission -> the WIDEST scope granted for it, unioned across every role
  // assignment this subject holds. Owners get an implicit all-permissions-at-academy-scope map.
  perms_map?: Map<PermissionKey, PermissionScope>;
  // Branches this subject may act on. `undefined` means the whole group (an owner); a staff
  // subject always has an explicit list, which may be empty.
  allowed_branch_ids?: string[];
  // Coach ids backing this subject's teacher assignments — the 'assigned' scope. A teacher
  // sees only batches whose `coachId` is in here.
  coach_ids?: string[];
  // Set when role === 'admin' (equals `id`); the AdminUser row is (re)loaded per request.
  adminId?: string;
  // Admin permissions from the JWT `perms` claim. Plumbed but not enforced yet (single role).
  perms?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
  interface FastifyInstance {
    // The second argument IS enforced for academy-side requests, unlike `requireAdmin`'s.
    // For an OWNER token it is a no-op (an owner holds every permission), which is what let
    // the key be threaded through the 77 existing handlers one route at a time.
    requireAuth: (
      role?: 'student' | 'academy',
      permission?: PermissionKey,
    ) => (req: FastifyRequest) => Promise<void>;
    // Student discovery reads: anonymous when no Authorization header is sent (req.user is then
    // UNSET — read it as `req.user?.id`), otherwise identical to requireAuth('student').
    optionalStudentAuth: () => (req: FastifyRequest) => Promise<void>;
    // `perm` is accepted for forward-compatible RBAC but not enforced yet (single admin role).
    requireAdmin: (perm?: string) => (req: FastifyRequest) => Promise<void>;
  }
}
