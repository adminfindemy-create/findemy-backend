import { AppError } from './app-error.js';
import { newId } from './id.js';
import { prisma } from './prisma.js';

// Family accounts. `User` is the account (login, payments, push); `Learner` is whoever attends.
// Every user has a self learner (User.selfLearnerId), created at sign-up and backfilled for older
// accounts, so a request that names no learner always has one to fall back to.
// See ai-usage/final-app/plan/family-accounts.md.

type Db = typeof prisma;

/**
 * Nested-create input that gives a new user their self learner. Spread into `user.create({ data })`
 * so user, learner and guardianship are written in one statement.
 */
export function selfLearnerCreate(params: { name: string | null | undefined; avatarInitial: string; attendanceOtp: string }) {
  const learnerId = newId();
  return {
    selfLearner: {
      create: {
        id: learnerId,
        name: params.name ?? '',
        avatarInitial: params.avatarInitial,
        attendanceOtp: params.attendanceOtp,
      },
    },
    guardianships: { create: { learnerId, role: 'self' as const } },
  };
}

/** The user's self learner id. Throws if the account has none (backfill not run). */
export async function selfLearnerId(userId: string, db: Db = prisma): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { selfLearnerId: true } });
  if (!user?.selfLearnerId) throw new AppError('INTERNAL', 500, 'Account has no learner profile');
  return user.selfLearnerId;
}

/**
 * The learner a student request acts for. Every student route that takes or returns a learner goes
 * through this. No id → the caller's self learner, so old app builds keep working. An id the
 * caller does not guard is a 404, never a 403, so nobody can probe whether a learner exists.
 */
export async function resolveLearner(userId: string, learnerId?: string | null, db: Db = prisma) {
  const id = learnerId || (await selfLearnerId(userId, db));
  const g = await db.guardianship.findUnique({
    where: { userId_learnerId: { userId, learnerId: id } },
    include: { learner: true },
  });
  if (!g || g.learner.status !== 'active') throw new AppError('NOT_FOUND', 404, 'Learner not found');
  return g.learner;
}

/** Every learner this account guards, archived ones included (their history stays readable). */
export async function guardedLearnerIds(userId: string, db: Db = prisma): Promise<string[]> {
  const rows = await db.guardianship.findMany({ where: { userId }, select: { learnerId: true } });
  return rows.map((r) => r.learnerId);
}

/**
 * Academy-side requests name a student by learner id. Older academy-app builds still send the
 * account's user id; that maps to the account's self learner, which is the same person for every
 * account created before family profiles.
 */
export async function learnerIdFromStudentRef(ref: { learner_id?: string; user_id?: string }, db: Db = prisma) {
  if (ref.learner_id) return ref.learner_id;
  if (ref.user_id) {
    const user = await db.user.findUnique({ where: { id: ref.user_id }, select: { selfLearnerId: true } });
    if (user?.selfLearnerId) return user.selfLearnerId;
    // Not a user id: newer clients may pass a learner id in the old field.
    return ref.user_id;
  }
  throw new AppError('VALIDATION', 400, 'learner_id is required');
}

/** Whole years between a date of birth and `on`. */
export function ageOn(dob: Date, on: Date = new Date()): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const m = on.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * Block a learner from a batch their age or gender rules out. A learner whose age or gender is
 * unknown is let through: the batch rule cannot be checked, and blocking on missing data would
 * stop every adult who never entered a date of birth. A self learner falls back to the account's
 * `age` from onboarding.
 */
export async function assertLearnerFitsBatch(
  learner: { id: string; dob: Date | null; gender: string | null },
  batch: { minAge: number | null; maxAge: number | null; gender: string },
  db: Db = prisma,
) {
  let age = learner.dob ? ageOn(learner.dob) : null;
  if (age === null) {
    const self = await db.user.findUnique({ where: { selfLearnerId: learner.id }, select: { age: true } });
    age = self?.age ?? null;
  }
  if (age !== null) {
    if (batch.minAge !== null && age < batch.minAge) {
      throw new AppError('AGE_MISMATCH', 422, `This batch is for ages ${batch.minAge}+`);
    }
    if (batch.maxAge !== null && age > batch.maxAge) {
      throw new AppError('AGE_MISMATCH', 422, `This batch is for ages up to ${batch.maxAge}`);
    }
  }
  if (batch.gender === 'female_only' && learner.gender === 'male') {
    throw new AppError('GENDER_MISMATCH', 422, 'This batch is for women and girls only');
  }
}

/** Self learner ids for many users at once, keyed by user id. Users without one are left out. */
export async function selfLearnerIds(userIds: string[], db: Db = prisma): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, selfLearnerId: true },
  });
  return new Map(users.filter((u) => u.selfLearnerId).map((u) => [u.id, u.selfLearnerId as string]));
}

/** Prisma select for the learner fields an academy-side student card needs. */
export const LEARNER_CARD_SELECT = { select: { id: true, name: true, dob: true } } as const;

/**
 * How the academy sees a student: the learner's name and age, the guardian account's phone (a
 * child has no login of their own), and the guardian's name so the desk knows whom to call. For a
 * self learner the guardian is the student, and the account's onboarding age stands in for a DOB.
 */
export function studentCard(
  user: { name: string | null; phone?: string | null; age?: number | null },
  learner: { id: string; name: string; dob: Date | null } | null,
) {
  return {
    learner_id: learner?.id ?? null,
    name: learner?.name || user.name,
    age: learner?.dob ? ageOn(learner.dob) : (user.age ?? null),
    phone: user.phone ?? null,
    guardian_name: user.name,
  };
}

/** Prisma select for naming a learner in a push: their name, and whether they are the account holder. */
export const LEARNER_PUSH_SELECT = { select: { name: true, selfOf: { select: { id: true } } } } as const;

/**
 * Whose class a push is about: "Your" for the account holder's own, "Aarav's" for a child, so a
 * parent with two children can tell the reminders apart. `lower` for mid-sentence use.
 */
export function whose(
  learner: { name: string; selfOf: { id: string } | null } | null | undefined,
  opts: { lower?: boolean } = {},
): string {
  if (learner && !learner.selfOf && learner.name) return `${learner.name}'s`;
  return opts.lower ? 'your' : 'Your';
}
