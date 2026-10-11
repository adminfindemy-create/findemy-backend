import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, isReserved, type PermissionKey } from '../lib/permissions.js';

/**
 * Invariant 6, and the test that keeps the permission catalogue honest as routes are added.
 *
 * Three failure modes, all silent without this:
 *   - a new `/studio/*` route ships with no permission key and is therefore open to every
 *     academy principal, including a teacher;
 *   - a route is gated on a key that does not exist, which the guard treats as "nobody has it"
 *     and 403s everyone including the owner;
 *   - a route is gated on a RESERVED key, which looks guarded but is held by no staff role, so
 *     the route is unreachable for staff while appearing correct in review.
 *
 * Deliberately a static scan of the route sources rather than a walk of a booted Fastify
 * instance: booting needs env + a database, and this must run in the ordinary unit suite.
 */

const MODULES = join(import.meta.dirname, '..', 'modules');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === 'routes.ts') out.push(p);
  }
  return out;
}

type Route = { file: string; method: string; path: string; permission: string | null };

// Matches `app.get('/studio/x', { preHandler: app.requireAuth('academy'[, 'key']) }`.
const ROUTE_RE =
  /app\.(get|post|put|delete)\(\s*'([^']+)'\s*,\s*\{\s*preHandler:\s*app\.requireAuth\(\s*'academy'\s*(?:,\s*'([^']+)'\s*)?\)/g;

function parseRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of routeFiles(MODULES)) {
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(ROUTE_RE)) {
      routes.push({ file, method: m[1], path: m[2], permission: m[3] ?? null });
    }
  }
  return routes;
}

const ROUTES = parseRoutes();

// Routes that run BEFORE the brand exists, so there is no scope to check them against.
const INTENTIONALLY_UNGATED = new Set([
  'post /academy/onboarding',
  // "What am I?" — every academy-side principal may ask, including one that holds nothing.
  'get /studio/session',
  // Self-scoped: both resolve the caller's OWN coach row from `req.user.coach_ids`, never from
  // a path parameter, so there is no other person's profile they could reach. A caller without
  // one gets a 404. See modules/studio/teaching-profile.ts.
  'get /studio/me/teaching-profile',
  'put /studio/me/teaching-profile',
  // Same shape: the caller's own account, resolved from `req.user.id`.
  'get /studio/me/account',
  'put /studio/me/account',
]);

describe('route permission coverage', () => {
  it('finds the academy route surface (guards against the regex silently matching nothing)', () => {
    expect(ROUTES.length).toBeGreaterThan(60);
  });

  it('every /studio/* route declares a permission key', () => {
    const ungated = ROUTES.filter(
      (r) => r.path.startsWith('/studio/') && !r.permission && !INTENTIONALLY_UNGATED.has(`${r.method} ${r.path}`),
    ).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(ungated).toEqual([]);
  });

  it('every declared key exists in the catalogue', () => {
    const unknown = ROUTES.filter((r) => r.permission && !(r.permission in PERMISSIONS)).map(
      (r) => `${r.method.toUpperCase()} ${r.path} -> ${r.permission}`,
    );
    expect(unknown).toEqual([]);
  });

  it('no route is gated on a RESERVED key', () => {
    const reserved = ROUTES.filter(
      (r) => r.permission && r.permission in PERMISSIONS && isReserved(r.permission as PermissionKey),
    ).map((r) => `${r.method.toUpperCase()} ${r.path} -> ${r.permission}`);
    expect(reserved).toEqual([]);
  });

  it('the live money route is gated on refunds.issue', () => {
    const refund = ROUTES.find((r) => r.path === '/studio/batches/:id/discontinuation/refund');
    expect(refund?.permission).toBe('refunds.issue');
  });
});
