/**
 * Resolves the bare actor ids scattered across the schema into display names.
 *
 * `ClassNote.createdByAccountId`, `Trial.attendanceMarkedByAccountId`,
 * `BatchAttendance.markedByAccountId` and `ClassSession.cancelledByAccountId` are all plain
 * `String` columns with NO foreign key — which is exactly why the cron workers can write the
 * literal `'system'` into them. That freedom is what lets a StaffAccount id land in them with
 * no schema change at all; the cost is that reading one back means probing both identity
 * tables, which is what this does.
 *
 * Adding a `*ByRole` companion column to each of those four would save one indexed lookup on a
 * pure display path, at the price of four migrations. Deliberately not done.
 *
 * See ai-usage/final-app/plan/academy-staff-roles.md §8.
 */
import { prisma } from './prisma.js';
import { SYSTEM_ACTOR_ID } from '../modules/admin/audit.js';

export type ResolvedActor = {
  id: string;
  name: string;
  kind: 'owner' | 'staff' | 'admin' | 'system' | 'unknown';
};

const SYSTEM: ResolvedActor = { id: SYSTEM_ACTOR_ID, name: 'Findemy', kind: 'system' };

/**
 * Batch-resolve ids to names. Unknown ids resolve to a placeholder rather than being dropped:
 * a row whose actor was deleted must still render as a row, not vanish from an audit trail.
 */
export async function resolveActors(ids: readonly string[]): Promise<Map<string, ResolvedActor>> {
  const out = new Map<string, ResolvedActor>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return out;

  const realIds = wanted.filter((id) => id !== SYSTEM_ACTOR_ID);
  if (wanted.length !== realIds.length) out.set(SYSTEM_ACTOR_ID, SYSTEM);
  if (realIds.length === 0) return out;

  const [owners, staff, admins] = await Promise.all([
    prisma.academyAccount.findMany({
      where: { id: { in: realIds } },
      select: { id: true, ownerName: true, phone: true },
    }),
    prisma.staffAccount.findMany({
      where: { id: { in: realIds } },
      select: { id: true, name: true },
    }),
    prisma.adminUser.findMany({
      where: { id: { in: realIds } },
      select: { id: true, name: true },
    }),
  ]);

  for (const o of owners) {
    out.set(o.id, { id: o.id, name: o.ownerName ?? o.phone ?? 'Owner', kind: 'owner' });
  }
  for (const s of staff) out.set(s.id, { id: s.id, name: s.name, kind: 'staff' });
  for (const a of admins) out.set(a.id, { id: a.id, name: a.name, kind: 'admin' });

  for (const id of realIds) {
    if (!out.has(id)) out.set(id, { id, name: 'Unknown', kind: 'unknown' });
  }
  return out;
}
