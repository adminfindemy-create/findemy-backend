import { prisma } from '../../lib/prisma.js';

export async function getCoaches(academyId: string) {
  return prisma.coach.findMany({
    where: { academyId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { batches: true } } }, // S4.2: derived batch_count
  });
}

// S4.2: coach detail + the batches assigned to it.
export async function getCoachById(id: string, academyId: string) {
  return prisma.coach.findFirst({
    where: { id, academyId },
    include: { batches: { select: { id: true, title: true } } },
  });
}

// S4.2: verify a coach belongs to the academy (for the assign-to-batch ownership check).
export async function coachBelongsToAcademy(coachId: string, academyId: string) {
  return prisma.coach.findFirst({ where: { id: coachId, academyId }, select: { id: true } });
}

export async function createCoach(data: {
  academyId: string;
  name: string;
  specialty: string;
  bio?: string;
  phone?: string;
  avatarUrl?: string | null;
}) {
  return prisma.coach.create({ data });
}

export async function updateCoach(
  id: string,
  academyId: string,
  data: { name?: string; specialty?: string; bio?: string; phone?: string },
) {
  return prisma.coach.updateMany({
    where: { id, academyId },
    data,
  });
}

export async function deleteCoach(id: string, academyId: string) {
  return prisma.coach.deleteMany({
    where: { id, academyId },
  });
}
