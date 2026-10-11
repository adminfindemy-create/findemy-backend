import { prisma } from '../../lib/prisma.js';

// Coaches are BRAND-level: one Rahul, teaching at whichever branches his batches run at,
// instead of a duplicate Rahul row per location. `homeBranchId` is a display label only —
// per-branch access restriction is deliberately deferred (plan §10).
// `Coach` is brand-level: coaches float between branches and `Batch.coachId` pins them per
// batch, so there is no `academyId` to filter on. A branch-scoped subject sees the coaches who
// actually teach at a branch they hold — plus those with no batches at all, because a coach is
// created BEFORE their first batch exists and hiding them would break onboarding a teacher.
export async function getCoaches(groupId: string, allowedIds?: string[]) {
  return prisma.coach.findMany({
    where: {
      groupId,
      ...(allowedIds
        ? {
            OR: [
              { batches: { some: { academyId: { in: allowedIds } } } },
              { batches: { none: {} } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { batches: true } }, // S4.2: derived batch_count
      homeBranch: { select: { id: true, name: true, branchLabel: true } },
    },
  });
}

// S4.2: coach detail + the batches assigned to it. Batches carry their branch so the studio
// can show which locations a coach actually teaches at.
export async function getCoachById(id: string, groupId: string) {
  return prisma.coach.findFirst({
    where: { id, groupId },
    include: {
      batches: {
        select: {
          id: true,
          title: true,
          academy: { select: { id: true, name: true, branchLabel: true } },
        },
      },
      homeBranch: { select: { id: true, name: true, branchLabel: true } },
    },
  });
}

// S4.2: verify a coach belongs to the same BRAND as the batch being edited. This is
// invariant §3.2 — a batch pointing at another brand's coach is silent, permanent corruption.
// Everything `deleteCoach` needs to refuse safely: does anyone teach with this row, and does a
// login depend on it?
export async function getCoachForDelete(id: string, groupId: string) {
  return prisma.coach.findFirst({
    where: { id, groupId },
    select: {
      id: true,
      _count: { select: { batches: true } },
      staffAssignments: { select: { id: true } },
    },
  });
}

export async function coachBelongsToGroup(coachId: string, groupId: string) {
  return prisma.coach.findFirst({ where: { id: coachId, groupId }, select: { id: true } });
}

export async function createCoach(data: {
  groupId: string;
  name: string;
  specialty: string;
  bio?: string;
  phone?: string;
  avatarUrl?: string | null;
  homeBranchId?: string | null;
}) {
  return prisma.coach.create({ data });
}

export async function updateCoach(
  id: string,
  groupId: string,
  data: {
    name?: string;
    specialty?: string;
    bio?: string;
    phone?: string;
    homeBranchId?: string | null;
  },
) {
  return prisma.coach.updateMany({
    where: { id, groupId },
    data,
  });
}

export async function deleteCoach(id: string, groupId: string) {
  return prisma.coach.deleteMany({
    where: { id, groupId },
  });
}
