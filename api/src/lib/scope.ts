/**
 * WHICH BATCHES this request may touch.
 *
 * `scope: 'assigned'` has to actually filter queries — a teacher hitting `GET /studio/students`
 * must not receive the whole branch's roster. This is the one place that decides it.
 *
 * The reason this is small: every academy-side read funnels through a `Batch` lookup keyed on
 * `academyId`, and everything downstream (the enrollment / attendance queries in
 * `attendance/review.ts` and `studio/service.ts`) is already gated by an ALREADY-RESOLVED
 * batch. Scope the batch resolution and everything beneath it is scoped.
 *
 * ⚠️ Every academy-side Batch query spreads this instead of writing `{ academyId }` literally.
 * That literal is the ONLY thing between a teacher and the whole branch's roster, so it must
 * not be re-derived per call site — the pre-existing cross-tenant leak in
 * `getSessionAttendance` existed precisely because one call site wrote its own filter.
 *
 * See ai-usage/final-app/plan/academy-staff-roles.md §5.
 */
import type { AuthUser } from '../types.js';
import type { PermissionKey } from './permissions.js';

/**
 * A `where` fragment for `prisma.batch.*`. Always contains `academyId`; additionally contains
 * a `coachId` filter when the subject only holds the permission at `assigned` scope.
 */
export type BatchScope = { academyId: string; coachId?: { in: string[] } };

export function batchScope(user: AuthUser, permission: PermissionKey): BatchScope {
  const base: BatchScope = { academyId: user.academy_id! };
  const scope = user.perms_map?.get(permission);

  // 'academy' and 'branch' both resolve to the effective branch, which auth step 3 has already
  // validated against this subject's allowed branch set. Only 'assigned' narrows further.
  if (scope !== 'assigned') return base;

  // A teacher with no linked coach teaches nothing, so `in: []` — an empty result — is the
  // CORRECT answer, not a missing filter. Getting this backwards is a full-roster leak, which
  // is why it is written out rather than left to a truthiness check.
  return { ...base, coachId: { in: user.coach_ids ?? [] } };
}

/**
 * Narrow a scope to ONE batch id, for routes that take `:id` or a `batch_id` query param.
 *
 * ⚠️ Use this instead of `{ ...scope, id: batchId }`. Spreading the id after the scope is fine
 * for `academyId`, but a caller who reorders it — or who later adds an `id: { in: [...] }` to
 * the scope — silently overwrites the filter and widens it. Going through a function makes the
 * ordering impossible to get wrong, and keeps `coachId` intact so a teacher asking for another
 * coach's batch id gets `null`, which the services already turn into a 404.
 */
export function batchScopeById(scope: BatchScope, batchId: string): BatchScope & { id: string } {
  return { ...scope, id: batchId };
}

/**
 * The same restriction expressed as a nested filter, for queries whose root is not `Batch`
 * (e.g. `prisma.enrollment.findMany({ where: { batch: ... } })`).
 */
export function nestedBatchScope(scope: BatchScope) {
  return scope;
}

/** True when this subject is limited to its own batches — useful for empty-state copy. */
export function isAssignedScope(scope: BatchScope): boolean {
  return scope.coachId !== undefined;
}

/**
 * The same idea for WORKSHOPS, which reach their coaches through a join table rather than a
 * column — a workshop can be co-hosted, so `WorkshopCoach` is a list where `Batch.coachId` is
 * one id.
 *
 * A teacher with no linked coach gets `in: []`, exactly as `batchScope` does: an empty result
 * is the right answer, not an absent filter. And a workshop with NO coaches at all — the owner
 * running it themselves — matches no teacher, which is the intent.
 */
export type WorkshopScope = {
  academyId: string;
  coaches?: { some: { coachId: { in: string[] } } };
};

export function workshopScope(user: AuthUser, permission: PermissionKey): WorkshopScope {
  const base: WorkshopScope = { academyId: user.academy_id! };
  if (user.perms_map?.get(permission) !== 'assigned') return base;
  return { ...base, coaches: { some: { coachId: { in: user.coach_ids ?? [] } } } };
}

export function isAssignedWorkshopScope(scope: WorkshopScope): boolean {
  return scope.coaches !== undefined;
}
