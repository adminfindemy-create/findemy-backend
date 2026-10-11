// Seeds the three SYSTEM staff roles (owner / manager / teacher) and their full permission
// matrix from src/lib/permissions.ts. Idempotent — safe to re-run, and re-run by `pnpm seed`.
//
// Usage:
//   pnpm seed:staff-roles          # standalone
//   pnpm seed                      # runs seedStaffRoles() as part of the full seed
//
// System roles are shared by every brand: they are rows with `groupId = NULL` and
// `isSystem = true`, so a new academy needs no per-brand role setup. Custom per-brand roles are
// later rows with a `groupId` and `isSystem = false` — data only, no migration.
//
// ⚠️ This script is the ONLY writer of staff_roles / staff_role_permissions for system roles,
// and it ASSERTS that the database holds no system-role grant outside ROLE_MATRIX. That
// assertion is what keeps the design doc's matrix and what Postgres actually grants from
// drifting apart; if it fires, fix permissions.ts rather than the database.
//
// See ai-usage/final-app/plan/academy-staff-roles.md §9.1.
import { PrismaClient } from '@prisma/client';
import {
  ROLE_KEYS,
  ROLE_LABELS,
  ROLE_MATRIX,
  assertReservedKeysOwnerOnly,
  type PermissionKey,
} from '../src/lib/permissions.js';

export async function seedStaffRoles(prisma: PrismaClient): Promise<void> {
  assertReservedKeysOwnerOnly();

  for (const key of ROLE_KEYS) {
    // `@@unique([key, groupId])` cannot be used in a Prisma `where` when groupId is NULL
    // (Postgres treats NULLs as distinct in unique indexes), so the system row is found by
    // an explicit findFirst on groupId: null.
    const existing = await prisma.staffRole.findFirst({
      where: { key, groupId: null, isSystem: true },
      select: { id: true },
    });

    const role = existing
      ? await prisma.staffRole.update({
          where: { id: existing.id },
          data: { label: ROLE_LABELS[key] },
        })
      : await prisma.staffRole.create({
          data: { key, label: ROLE_LABELS[key], isSystem: true, groupId: null },
        });

    const grants = ROLE_MATRIX[key];
    const wanted = Object.keys(grants) as PermissionKey[];

    for (const permission of wanted) {
      const grant = grants[permission]!;
      await prisma.staffRolePermission.upsert({
        where: { roleId_permission: { roleId: role.id, permission } },
        create: {
          roleId: role.id,
          permission,
          scope: grant.scope,
          deny: grant.deny ?? false,
        },
        update: { scope: grant.scope, deny: grant.deny ?? false },
      });
    }

    // Remove grants the catalogue no longer contains, so deleting a key from permissions.ts
    // actually revokes it instead of leaving an orphan row that still grants access.
    const removed = await prisma.staffRolePermission.deleteMany({
      where: { roleId: role.id, permission: { notIn: wanted } },
    });

    const denies = wanted.filter((p) => grants[p]?.deny).length;
    console.log(
      `[seed-staff-roles] ${key}: ${wanted.length} permissions (${denies} deny)` +
        (removed.count ? `, ${removed.count} stale removed` : ''),
    );
  }

  // The drift assertion. Every system-role grant in the database must be one ROLE_MATRIX names.
  const systemRoles = await prisma.staffRole.findMany({
    where: { isSystem: true },
    include: { permissions: { select: { permission: true, scope: true, deny: true } } },
  });

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const role of systemRoles) {
    seen.add(role.key);
    const grants = ROLE_MATRIX[role.key as (typeof ROLE_KEYS)[number]];
    if (!grants) {
      problems.push(`system role '${role.key}' exists in the database but not in ROLE_MATRIX`);
      continue;
    }
    for (const p of role.permissions) {
      const want = grants[p.permission as PermissionKey];
      if (!want) {
        problems.push(`${role.key}: '${p.permission}' granted in the database but not in ROLE_MATRIX`);
      } else if (want.scope !== p.scope || (want.deny ?? false) !== p.deny) {
        problems.push(
          `${role.key}: '${p.permission}' is ${p.scope}/deny=${p.deny} in the database, ` +
            `ROLE_MATRIX says ${want.scope}/deny=${want.deny ?? false}`,
        );
      }
    }
  }
  for (const key of ROLE_KEYS) {
    if (!seen.has(key)) problems.push(`system role '${key}' is missing from the database`);
  }

  if (problems.length) {
    throw new Error(`[seed-staff-roles] catalogue drift:\n  - ${problems.join('\n  - ')}`);
  }

  console.log('[seed-staff-roles] catalogue matches the database exactly.');
}

// Standalone entrypoint. Skipped when imported by prisma/seed.ts, which passes its own client.
const isMain = process.argv[1]?.endsWith('seed-staff-roles.ts');
if (isMain) {
  const prisma = new PrismaClient();
  seedStaffRoles(prisma)
    .catch((err) => {
      console.error('[seed-staff-roles] failed', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
