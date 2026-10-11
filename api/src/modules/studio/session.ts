/**
 * `GET /studio/session` — what this login is and what it may do.
 *
 * The client renders navigation from this, never from a role name: asking "do I hold
 * `students.view`, and at what scope?" is stable, whereas `role === 'manager'` breaks the
 * moment custom roles exist. See academy-staff-roles.md §6.1 and decision 2.
 *
 * `/me/*` is entirely student-guarded, which is why this lives here rather than there.
 */
import type { FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import * as repo from './repo.js';
import { isProfileComplete } from './teaching-profile.js';

export async function getSession(req: FastifyRequest) {
  const groupId = req.user.group_id;
  const isStaff = req.user.sub_kind === 'staff';

  const [identity, roles] = await Promise.all([
    isStaff
      ? prisma.staffAccount
          .findUnique({ where: { id: req.user.id }, select: { name: true, phone: true } })
          .then((s) => ({ name: s?.name ?? null, phone: s?.phone ?? null }))
      : prisma.academyAccount
          .findUnique({ where: { id: req.user.id }, select: { ownerName: true, phone: true } })
          .then((a) => ({ name: a?.ownerName ?? null, phone: a?.phone ?? null })),
    isStaff
      ? prisma.staffRoleAssignment.findMany({
          where: { staffId: req.user.id },
          select: { role: { select: { key: true, label: true } } },
        })
      : Promise.resolve([]),
  ]);

  // ALREADY filtered to this subject's scope, which is what makes the client's existing
  // stale-active-branch fallback in `setBranches` correct for free — a branch it cannot see is
  // a branch it cannot try to select.
  const branches = groupId
    ? await repo.listBranches(groupId, req.user.allowed_branch_ids)
    : [];

  const permissions: Record<string, string> = {};
  for (const [key, scope] of req.user.perms_map ?? []) permissions[key] = scope;

  // Drives the teacher's "finish your profile" prompt. Null for anyone without a teaching
  // profile (an owner, a manager) so the client can tell "not applicable" from "not done".
  const ownCoachId = req.user.coach_ids?.[0];
  const ownCoach = ownCoachId
    ? await prisma.coach.findUnique({ where: { id: ownCoachId }, select: { specialty: true } })
    : null;
  const teachingProfileComplete = ownCoachId ? isProfileComplete(ownCoach) : null;

  return {
    sub_kind: req.user.sub_kind ?? 'owner',
    name: identity.name,
    phone: identity.phone,
    group_id: groupId ?? null,
    active_branch_id: req.user.academy_id ?? null,
    roles: isStaff
      ? roles.map((r) => ({ key: r.role.key, label: r.role.label }))
      : [{ key: 'owner', label: 'Owner' }],
    permissions,
    // The 'assigned' scope's backing coaches. Empty for an owner or a manager.
    coach_ids: req.user.coach_ids ?? [],
    // true / false for a teacher; null for anyone who has no teaching profile at all.
    teaching_profile_complete: teachingProfileComplete,
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      branch_label: b.branchLabel,
      category: b.category,
      address: b.address,
      lat: b.lat,
      lng: b.lng,
      status: b.status,
      verified: b.verified,
      rating: b.rating,
      rating_count: b.ratingCount,
      images: b.images,
      financial_entity_id: b.financialEntityId,
      active_batch_count: b._count.batches,
      is_active: b.id === req.user.academy_id,
      created_at: b.createdAt.toISOString(),
    })),
  };
}
