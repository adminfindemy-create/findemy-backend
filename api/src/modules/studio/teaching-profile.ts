/**
 * `GET/PUT /studio/me/teaching-profile` — the teacher's own public identity.
 *
 * Self-scoped, so it carries NO permission key: the coach row is resolved from the caller's own
 * `req.user.coach_ids`, never from a path parameter, so there is nothing to authorize beyond
 * being an academy-side principal. A caller with no linked coach (an owner, a manager) gets a
 * 404 rather than a 403 — they have not been denied someone else's profile, they simply do not
 * have one.
 *
 * The OWNER edits the same row through `PUT /studio/coaches/:id` (`coaches.manage`). Two
 * entry points, one write path in `coaches/service.ts`, so the two cannot drift.
 *
 * See the People-unification plan: the owner grants access, the teacher describes themselves.
 */
import type { FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { toPrismaData, type CoachInput } from '../coaches/service.js';

/**
 * A profile counts as complete once it says what the person teaches. `specialty` is the one
 * field a learner actually sees beyond the name, and it starts empty when the invite creates
 * the row — so it is both the honest signal and the one worth prompting for.
 *
 * Derived, never stored, matching how owner onboarding completeness already works.
 */
export function isProfileComplete(coach: { specialty: string | null } | null): boolean {
  return !!coach?.specialty?.trim();
}

async function requireOwnCoach(req: FastifyRequest) {
  const coachId = req.user.coach_ids?.[0];
  if (!coachId) {
    throw new AppError('NOT_FOUND', 404, 'You do not have a teaching profile');
  }
  // Re-read scoped by the brand rather than trusting the id from the session alone.
  const coach = await prisma.coach.findFirst({
    where: { id: coachId, groupId: req.user.group_id! },
  });
  if (!coach) throw new AppError('NOT_FOUND', 404, 'You do not have a teaching profile');
  return coach;
}

export async function getMyTeachingProfile(req: FastifyRequest) {
  const coach = await requireOwnCoach(req);
  return {
    profile: {
      id: coach.id,
      name: coach.name,
      specialty: coach.specialty,
      bio: coach.bio,
      credentials: coach.credentials,
      avatar_url: coach.avatarUrl ?? null,
      complete: isProfileComplete(coach),
    },
  };
}

export async function updateMyTeachingProfile(req: FastifyRequest, data: CoachInput) {
  const coach = await requireOwnCoach(req);
  await prisma.$transaction(async (tx) => {
    await tx.coach.update({ where: { id: coach.id }, data: toPrismaData(data) });
    // ONE PERSON, ONE NAME. `updateStaff` already keeps these in step when an owner edits
    // someone; without the same here, a teacher renaming themselves would change what students
    // see while the People list kept showing the old name.
    if (data.name && req.user.sub_kind === 'staff') {
      await tx.staffAccount.update({ where: { id: req.user.id }, data: { name: data.name } });
    }
  });
  return getMyTeachingProfile(req);
}
