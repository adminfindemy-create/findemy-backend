import { AppError } from '../../lib/app-error.js';
import * as repo from './repo.js';

export async function getCoaches(academyId: string) {
  const coaches = await repo.getCoaches(academyId);
  return {
    items: coaches.map((c) => ({
      id: c.id,
      name: c.name,
      specialty: c.specialty,
      bio: c.bio,
      phone: c.phone,
      avatar_url: c.avatarUrl ?? null,
      batch_count: c._count.batches,
    })),
  };
}

// S4.2: coach detail — profile + assigned batches.
export async function getCoach(id: string, academyId: string) {
  const coach = await repo.getCoachById(id, academyId);
  if (!coach) throw new AppError('NOT_FOUND', 404, 'Coach not found');
  return {
    coach: {
      id: coach.id,
      name: coach.name,
      specialty: coach.specialty,
      bio: coach.bio,
      phone: coach.phone,
      avatar_url: coach.avatarUrl ?? null,
      batch_count: coach.batches.length,
      batches: coach.batches.map((b) => ({ id: b.id, title: b.title })),
    },
  };
}

export async function createCoach(
  academyId: string,
  data: { name: string; specialty: string; bio?: string; phone?: string; avatar_url?: string | null },
) {
  const { avatar_url, ...rest } = data;
  const coach = await repo.createCoach({ academyId, ...rest, avatarUrl: avatar_url ?? undefined });
  return { coach: { id: coach.id } };
}

export async function updateCoach(
  id: string,
  academyId: string,
  data: { name?: string; specialty?: string; bio?: string; phone?: string; avatar_url?: string | null },
) {
  const { avatar_url, ...rest } = data;
  const prismaData: Record<string, unknown> = { ...rest };
  if (avatar_url !== undefined) prismaData.avatarUrl = avatar_url; // null clears it
  await repo.updateCoach(id, academyId, prismaData);
  return { coach: { id } };
}

export async function deleteCoach(id: string, academyId: string) {
  await repo.deleteCoach(id, academyId);
  return {};
}
