import { prisma } from '../../lib/prisma.js';

// Everything the staff list and detail screens render, in one shape.
export const STAFF_INCLUDE = {
  assignments: {
    include: {
      role: { select: { id: true, key: true, label: true } },
      coach: { select: { id: true, name: true } },
      branches: { include: { academy: { select: { id: true, name: true, branchLabel: true } } } },
    },
  },
} as const;

export async function listStaff(groupId: string) {
  return prisma.staffAccount.findMany({
    where: { groupId },
    include: STAFF_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });
}

export async function getStaff(id: string, groupId: string) {
  // Scoped by groupId, not just id: a staff id from another brand must read as "not found".
  return prisma.staffAccount.findFirst({ where: { id, groupId }, include: STAFF_INCLUDE });
}

export async function findStaffByPhoneAnyBrand(phone: string) {
  return prisma.staffAccount.findUnique({
    where: { phone },
    select: { id: true, groupId: true, status: true },
  });
}

export async function findAcademyAccountByPhone(phone: string) {
  return prisma.academyAccount.findUnique({ where: { phone }, select: { id: true, groupId: true } });
}

export async function getSystemRole(key: string) {
  // `@@unique([key, groupId])` is unusable in a Prisma `where` when groupId is NULL, because
  // Postgres treats NULLs in a unique index as distinct. findFirst is the correct lookup.
  return prisma.staffRole.findFirst({
    where: { key, groupId: null, isSystem: true },
    select: { id: true, key: true, label: true },
  });
}

export async function getBranchIds(groupId: string, ids: string[]) {
  const rows = await prisma.academy.findMany({
    where: { id: { in: ids }, groupId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// Used when a teacher is demoted: their batches must move before their profile can go.
export async function getCoachBatchCount(id: string, groupId: string) {
  return prisma.coach.findFirst({
    where: { id, groupId },
    select: { id: true, _count: { select: { batches: true } } },
  });
}

export async function getCoach(id: string, groupId: string) {
  return prisma.coach.findFirst({ where: { id, groupId }, select: { id: true } });
}

export async function bumpGrantsVersion(id: string) {
  return prisma.staffAccount.update({
    where: { id },
    data: { grantsVersion: { increment: 1 } },
  });
}
