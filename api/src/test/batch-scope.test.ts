import { describe, it, expect } from 'vitest';
import { batchScope, batchScopeById, isAssignedScope } from '../lib/scope.js';
import type { AuthUser } from '../types.js';
import type { PermissionKey, PermissionScope } from '../lib/permissions.js';

/**
 * `batchScope` is the ONLY thing between a teacher and the whole branch's roster: every
 * academy-side Batch query spreads it instead of writing `{ academyId }`. So its edge cases are
 * tested directly rather than only through the routes that use it.
 *
 * See ai-usage/final-app/plan/academy-staff-roles.md §5.
 */

function user(scope: PermissionScope | null, coachIds: string[] = []): AuthUser {
  const perms = new Map<PermissionKey, PermissionScope>();
  if (scope) perms.set('students.view', scope);
  return {
    id: 'sub_1',
    role: 'academy',
    academy_id: 'br_1',
    perms_map: perms,
    coach_ids: coachIds,
  };
}

describe('batchScope', () => {
  it('academy scope filters by branch only', () => {
    expect(batchScope(user('academy'), 'students.view')).toEqual({ academyId: 'br_1' });
  });

  it('branch scope is identical to academy scope — the effective branch is already resolved', () => {
    // Both produce the SAME row filter; their only difference is WHICH branches you may select,
    // which auth step 3a enforces. This is why the Manager slice needed no scope threading.
    expect(batchScope(user('branch'), 'students.view')).toEqual({ academyId: 'br_1' });
  });

  it('assigned scope adds the coach filter', () => {
    expect(batchScope(user('assigned', ['coach_1']), 'students.view')).toEqual({
      academyId: 'br_1',
      coachId: { in: ['coach_1'] },
    });
  });

  it('a teacher with NO coach gets `in: []` — an empty result, never a missing filter', () => {
    // Getting this backwards is a full-roster leak, which is why it is asserted explicitly.
    const s = batchScope(user('assigned', []), 'students.view');
    expect(s).toEqual({ academyId: 'br_1', coachId: { in: [] } });
    expect(s.coachId).toBeDefined();
  });

  it('undefined coach_ids also yields `in: []`, not an absent filter', () => {
    const u = user('assigned');
    delete (u as { coach_ids?: string[] }).coach_ids;
    expect(batchScope(u, 'students.view')).toEqual({ academyId: 'br_1', coachId: { in: [] } });
  });

  it('a DENIED permission does not silently widen the scope', () => {
    // The guard 403s before any handler runs, so this should never be reachable — but if a
    // route were ever gated on key A and scoped on key B, the fallback must not be "no filter".
    expect(batchScope(user(null), 'students.view')).toEqual({ academyId: 'br_1' });
  });

  it('several coaches union into one filter', () => {
    expect(batchScope(user('assigned', ['c1', 'c2']), 'students.view').coachId).toEqual({
      in: ['c1', 'c2'],
    });
  });
});

describe('batchScopeById — the query-param widening trap', () => {
  it('a batch id NARROWS the scope and keeps coachId intact', () => {
    const s = batchScope(user('assigned', ['coach_1']), 'students.view');
    // The §5.2 trap: writing `{ ...scope, id }` by hand is fine today, but going through this
    // helper is what makes it impossible to reorder into `{ id, ...scope }` and lose the id, or
    // to drop coachId when the scope shape changes.
    expect(batchScopeById(s, 'batch_x')).toEqual({
      academyId: 'br_1',
      coachId: { in: ['coach_1'] },
      id: 'batch_x',
    });
  });

  it('another coach’s batch id cannot widen an assigned scope', () => {
    const s = batchScopeById(batchScope(user('assigned', ['coach_1']), 'students.view'), 'other_batch');
    // Both conditions are ANDed by Prisma, so the row must match the id AND the coach set —
    // which another coach's batch cannot. The result is `null`, i.e. a 404, not that batch.
    expect(s.coachId).toEqual({ in: ['coach_1'] });
    expect(s.id).toBe('other_batch');
  });

  it('an owner’s scope with an id is just branch + id', () => {
    const s = batchScopeById(batchScope(user('academy'), 'students.view'), 'batch_x');
    expect(s).toEqual({ academyId: 'br_1', id: 'batch_x' });
    expect(s.coachId).toBeUndefined();
  });
});

describe('isAssignedScope', () => {
  it('distinguishes a self-limited subject from a branch-wide one', () => {
    expect(isAssignedScope(batchScope(user('assigned', ['c1']), 'students.view'))).toBe(true);
    expect(isAssignedScope(batchScope(user('branch'), 'students.view'))).toBe(false);
    expect(isAssignedScope(batchScope(user('academy'), 'students.view'))).toBe(false);
  });
});
