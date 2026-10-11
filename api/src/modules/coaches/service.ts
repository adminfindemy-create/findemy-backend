import { AppError } from '../../lib/app-error.js';
import * as repo from './repo.js';

/**
 * A coach's public teaching identity. `phone` is deliberately NOT part of this shape any more:
 * every coach now has a login, so `StaffAccount.phone` is the single place a person's number
 * lives — and the old `Coach.phone` was reaching logged-in students.
 */
function shape(c: {
  id: string;
  name: string;
  specialty: string;
  bio: string | null;
  credentials: string | null;
  avatarUrl: string | null;
}) {
  return {
    id: c.id,
    name: c.name,
    specialty: c.specialty,
    bio: c.bio,
    credentials: c.credentials,
    avatar_url: c.avatarUrl ?? null,
  };
}

export async function getCoaches(groupId: string, allowedIds?: string[]) {
  const coaches = await repo.getCoaches(groupId, allowedIds);
  return {
    items: coaches.map((c) => ({ ...shape(c), batch_count: c._count.batches })),
  };
}

// S4.2: coach detail — profile + assigned batches.
export async function getCoach(id: string, groupId: string) {
  const coach = await repo.getCoachById(id, groupId);
  if (!coach) throw new AppError('NOT_FOUND', 404, 'Coach not found');
  return {
    coach: {
      ...shape(coach),
      batch_count: coach.batches.length,
      batches: coach.batches.map((b) => ({ id: b.id, title: b.title })),
    },
  };
}

export type CoachInput = {
  name?: string;
  specialty?: string;
  bio?: string;
  credentials?: string;
  avatar_url?: string | null;
};

/** Maps the wire shape onto Prisma columns. Shared by the owner's edit and the teacher's own. */
export function toPrismaData(data: CoachInput): Record<string, unknown> {
  const { avatar_url, ...rest } = data;
  const out: Record<string, unknown> = { ...rest };
  if (avatar_url !== undefined) out.avatarUrl = avatar_url; // null clears it
  return out;
}

export async function createCoach(
  groupId: string,
  data: { name: string; specialty: string; bio?: string; credentials?: string; avatar_url?: string | null },
) {
  const coach = await repo.createCoach({ groupId, ...toPrismaData(data) } as never);
  return { coach: { id: coach.id } };
}

export async function updateCoach(id: string, groupId: string, data: CoachInput) {
  await repo.updateCoach(id, groupId, toPrismaData(data));
  return { coach: { id } };
}

/**
 * ⚠️ Guarded, where it used to be a bare delete.
 *
 * Two things could go wrong before. `Batch.coachId` is NOT NULL with `onDelete: Restrict`, so
 * deleting an assigned coach threw a raw Prisma error at the client. Worse,
 * `StaffRoleAssignment.coachId` is `ON DELETE SET NULL`, so deleting an unassigned-but-linked
 * coach SUCCEEDED and silently left that teacher's login with an empty 'assigned' scope — the
 * exact state the invite flow refuses to create.
 *
 * A person who has left is deactivated, not deleted: their id is referenced from class notes,
 * attendance marks and the audit log, all of which need the row to stay resolvable.
 */
export async function deleteCoach(id: string, groupId: string) {
  const coach = await repo.getCoachForDelete(id, groupId);
  if (!coach) throw new AppError('NOT_FOUND', 404, 'Coach not found');

  if (coach._count.batches > 0) {
    throw new AppError(
      'CONFLICT',
      409,
      'This coach still teaches batches. Reassign them to someone else first.',
    );
  }
  if (coach.staffAssignments.length > 0) {
    throw new AppError(
      'CONFLICT',
      409,
      'This person has app access. Remove their access from the People screen instead — that keeps their past classes and attendance on record.',
    );
  }

  await repo.deleteCoach(id, groupId);
  return {};
}
