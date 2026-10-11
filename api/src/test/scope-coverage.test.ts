import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_MATRIX, type PermissionKey } from '../lib/permissions.js';

/**
 * The companion to `route-permissions.test.ts`, for the OTHER half of authorization.
 *
 * That test proves every `/studio/*` route DECLARES a permission. This one proves the
 * teacher-reachable ones actually FILTER by it: a route can be perfectly gated on
 * `students.view` and still hand a teacher the whole branch's roster if its handler passes
 * `req.user.academy_id!` instead of a scope.
 *
 * TWO scope helpers count, because two shapes exist: `batchScope` for anything hanging off
 * `Batch.coachId`, and `workshopScope` for workshops, which reach their coaches through the
 * `WorkshopCoach` join table (a workshop can be co-hosted, so it is a list, not a column).
 *
 * Scoped to route handlers rather than to every query, deliberately. A broad grep over all
 * repo/service files needs a long allow-list of legitimate `academyId` uses — owner-only
 * writes, earnings aggregates, type signatures — and an allow-list that long stops being a
 * check and becomes a place to silence this test. The handler is where the decision is made,
 * so the handler is what is asserted.
 */

const MODULES = join(import.meta.dirname, '..', 'modules');

/** Keys a TEACHER holds at `assigned` scope — the ones whose routes must narrow by coach. */
const ASSIGNED_KEYS = new Set(
  (Object.keys(ROLE_MATRIX.teacher) as PermissionKey[]).filter(
    (k) => ROLE_MATRIX.teacher[k]?.scope === 'assigned' && !ROLE_MATRIX.teacher[k]?.deny,
  ),
);

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'routes.ts') out.push(p);
  }
  return out;
}

// One route registration, from `app.<verb>(` to the closing `});` of its handler.
const ROUTE_RE =
  /app\.(get|post|put|delete)\(\s*'([^']+)'\s*,\s*\{\s*preHandler:\s*app\.requireAuth\(\s*'academy'\s*,\s*'([^']+)'\s*\)[^]*?\n  \}\);/g;

type Route = { file: string; method: string; path: string; key: string; body: string };

function parseRoutes(): Route[] {
  const out: Route[] = [];
  for (const file of routeFiles(MODULES)) {
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(ROUTE_RE)) {
      out.push({ file, method: m[1], path: m[2], key: m[3], body: m[0] });
    }
  }
  return out;
}

const ROUTES = parseRoutes();
const ASSIGNED_ROUTES = ROUTES.filter((r) => ASSIGNED_KEYS.has(r.key as PermissionKey));

describe('batch scope coverage', () => {
  it('the parser actually found the teacher-reachable routes', () => {
    // Guards against the regex silently matching nothing and the suite passing vacuously.
    expect(ASSIGNED_KEYS.size).toBeGreaterThan(10);
    expect(ASSIGNED_ROUTES.length).toBeGreaterThan(15);
  });

  it('every teacher-reachable handler passes a scope, not a bare academy id', () => {
    const offenders = ASSIGNED_ROUTES.filter(
      (r) => !r.body.includes('batchScope(') && !r.body.includes('workshopScope('),
    ).map(
      (r) => `${r.method.toUpperCase()} ${r.path}  [${r.key}]`,
    );
    // The fix is to spread `batchScope(req.user, '<this route's key>')` into the query — never
    // to add the route to an exception list.
    expect(offenders).toEqual([]);
  });

  it('no teacher-reachable handler still reads req.user.academy_id directly', () => {
    const offenders = ASSIGNED_ROUTES.filter((r) => r.body.includes('req.user.academy_id')).map(
      (r) => `${r.method.toUpperCase()} ${r.path}  [${r.key}]`,
    );
    expect(offenders).toEqual([]);
  });

  it('each handler scopes on the SAME key it is gated on', () => {
    // A route gated on `attendance.export` but scoped on `attendance.view` would be narrowed by
    // the wrong permission — harmless today (both are `assigned`), a silent widening the moment
    // the two keys diverge for any role.
    const mismatched = ASSIGNED_ROUTES.filter((r) => {
      const used = [
        ...r.body.matchAll(/(?:batchScope|workshopScope)\(req\.user,\s*'([^']+)'\)/g),
      ].map((m) => m[1]);
      // `POST /studio/workshops/:id/live/token` is the deliberate exception: it is GATED on
      // `sessions.live` (may you host a live session at all?) but SCOPED on `workshops.view`
      // (which workshops are yours?). Two different questions, so two different keys.
      if (r.path.endsWith('/live/token')) return false;
      return used.length > 0 && !used.includes(r.key);
    }).map((r) => `${r.method.toUpperCase()} ${r.path}  gated on ${r.key}`);
    expect(mismatched).toEqual([]);
  });
});
