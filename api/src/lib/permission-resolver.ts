/**
 * Turns a subject into the two things authorization needs: WHAT it may do (a permission ->
 * widest-scope map) and WHERE it may do it (a branch id list, plus the coach ids backing any
 * teacher assignment).
 *
 * Loaded per request from the database, deliberately NOT carried in the JWT. This matches the
 * existing precedent twice over: `plugins/auth.ts` already prefers the DB over the token for
 * `groupId` so "an account whose group changed mid-session must not keep acting on the old
 * brand until its 15-minute access token expires", and `requireAdmin` reloads the AdminUser
 * allowlist row on every request. An owner revoking a role must take effect at once.
 *
 * See ai-usage/final-app/plan/academy-staff-roles.md §4.
 */
import { prisma } from './prisma.js';
import {
  PERMISSION_KEYS,
  ROLE_MATRIX,
  type PermissionKey,
  type PermissionScope,
} from './permissions.js';

export type EffectiveGrants = {
  perms: Map<PermissionKey, PermissionScope>;
  /** `undefined` = the whole group (owner). A staff subject always gets an explicit list. */
  branchIds?: string[];
  coachIds: string[];
};

/** Scope lattice: assigned < branch < academy. */
const RANK: Record<PermissionScope, number> = { assigned: 0, branch: 1, academy: 2 };

type LoadedGrant = { permission: string; scope: PermissionScope; deny: boolean };

/**
 * Union the grants of every role assignment a subject holds.
 *
 * Two rules, and both matter:
 *   - A permission granted by more than one assignment resolves to the WIDEST scope, so a
 *     manager who also coaches gets `branch` rather than `assigned` — one login, not two.
 *   - `deny` is absolute and ORDER-INDEPENDENT: denials are collected first and subtracted
 *     last, so a deny row on any assignment beats a grant on any other regardless of which
 *     happened to load first.
 */
export function unionGrants(grants: LoadedGrant[]): Map<PermissionKey, PermissionScope> {
  const out = new Map<PermissionKey, PermissionScope>();
  const denied = new Set<string>();

  for (const g of grants) {
    if (g.deny) {
      denied.add(g.permission);
      continue;
    }
    const key = g.permission as PermissionKey;
    const cur = out.get(key);
    if (!cur || RANK[g.scope] > RANK[cur]) out.set(key, g.scope);
  }
  for (const k of denied) out.delete(k as PermissionKey);
  return out;
}

/**
 * An OWNER holds every permission at brand scope.
 *
 * Derived in-process from `ROLE_MATRIX.owner` rather than queried, which is a DELIBERATE
 * deviation from the design doc's "one SQL query" phrasing: the owner role is a single shared
 * system row that only changes on deploy, so querying it would add a database roundtrip to
 * every one of the ~77 owner requests that has none today. What makes this safe is that
 * `seed-staff-roles.ts` ASSERTS the database holds exactly ROLE_MATRIX and nothing else — the
 * constant and the table cannot disagree. Narrowing what an owner may do is therefore an edit
 * here plus a reseed, not a change to any handler.
 */
const OWNER_PERMS: Map<PermissionKey, PermissionScope> = new Map(
  PERMISSION_KEYS.map((k) => [k, ROLE_MATRIX.owner[k]!.scope] as const),
);

export function ownerGrants(): EffectiveGrants {
  // A fresh Map per request: `req.user.perms_map` must never be a shared mutable object.
  return { perms: new Map(OWNER_PERMS), branchIds: undefined, coachIds: [] };
}

/**
 * Load a staff subject's effective grants. One indexed query, folded into the same round trip
 * that authorizes the account.
 */
export async function loadStaffGrants(staffId: string): Promise<EffectiveGrants> {
  const assignments = await prisma.staffRoleAssignment.findMany({
    where: { staffId },
    select: {
      coachId: true,
      branches: { select: { academyId: true } },
      role: { select: { permissions: { select: { permission: true, scope: true, deny: true } } } },
    },
  });

  const grants: LoadedGrant[] = [];
  const branchIds = new Set<string>();
  const coachIds = new Set<string>();

  for (const a of assignments) {
    for (const p of a.role.permissions) grants.push(p);
    for (const b of a.branches) branchIds.add(b.academyId);
    if (a.coachId) coachIds.add(a.coachId);
  }

  return {
    perms: unionGrants(grants),
    // Always an array, never undefined: `undefined` means "the whole group" and a staff
    // subject must never accidentally mean that. An empty array is the correct answer for a
    // staff account with no branch scope, and the guard turns it into a denial.
    branchIds: [...branchIds],
    coachIds: [...coachIds],
  };
}
