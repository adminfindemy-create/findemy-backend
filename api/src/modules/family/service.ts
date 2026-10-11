import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import { generateAttendanceOtp } from '../../lib/otp.js';
import { ageOn, guardedLearnerIds, resolveLearner } from '../../lib/learner-access.js';
import { monthRange } from '../attendance/stats.js';

// Family profiles: a parent adds children to their account and books, pays and tracks
// attendance for each. See ai-usage/final-app/plan/family-accounts.md.

/** Children per account, self learner not counted. */
export const MAX_CHILDREN = 6;
/** Bumped when the consent text shown in the app changes, so we know what each guardian agreed to. */
export const CONSENT_VERSION = '2026-10-10';

type LearnerRow = {
  id: string;
  name: string;
  dob: Date | null;
  gender: string | null;
  avatarInitial: string;
  status: string;
};

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

export function serializeLearner(l: LearnerRow, role: 'self' | 'owner') {
  return {
    id: l.id,
    name: l.name,
    dob: l.dob ? dateKey(l.dob) : null,
    age: l.dob ? ageOn(l.dob) : null,
    gender: l.gender,
    avatar_initial: l.avatarInitial,
    is_self: role === 'self',
    status: l.status,
  };
}

/** Active learners on the account, the account holder first. */
export async function listLearners(userId: string) {
  const rows = await prisma.guardianship.findMany({
    where: { userId, learner: { status: 'active' } },
    include: { learner: true },
    orderBy: { createdAt: 'asc' },
  });
  rows.sort((a, b) => (a.role === 'self' ? -1 : b.role === 'self' ? 1 : 0));
  return { learners: rows.map((g) => serializeLearner(g.learner, g.role)) };
}

function initialsOf(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || '??';
}

function parseDob(dob: string) {
  const d = new Date(`${dob}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new AppError('VALIDATION', 400, 'Invalid date of birth');
  if (d > new Date()) throw new AppError('VALIDATION', 400, 'Date of birth cannot be in the future');
  return d;
}

export async function addLearner(
  userId: string,
  body: { name: string; dob: string; gender?: 'male' | 'female' | 'other' },
) {
  const children = await prisma.guardianship.count({
    where: { userId, role: 'owner', learner: { status: 'active' } },
  });
  if (children >= MAX_CHILDREN) {
    throw new AppError('LEARNER_LIMIT', 409, `You can add up to ${MAX_CHILDREN} children`);
  }
  const name = body.name.trim();
  const learner = await prisma.learner.create({
    data: {
      id: newId(),
      name,
      dob: parseDob(body.dob),
      gender: body.gender ?? null,
      avatarInitial: initialsOf(name),
      attendanceOtp: generateAttendanceOtp(),
      // The route only accepts the request with consent ticked.
      consentAt: new Date(),
      consentVersion: CONSENT_VERSION,
      guardians: { create: { userId, role: 'owner' } },
    },
  });
  return { learner: serializeLearner(learner, 'owner') };
}

export async function updateLearner(
  userId: string,
  learnerId: string,
  body: { name?: string; dob?: string | null; gender?: 'male' | 'female' | 'other' | null },
) {
  const learner = await resolveLearner(userId, learnerId);
  const g = await prisma.guardianship.findUniqueOrThrow({ where: { userId_learnerId: { userId, learnerId } } });
  if (g.role === 'self' && body.name !== undefined) {
    // The self learner's name follows the account profile (PUT /me/onboarding).
    throw new AppError('VALIDATION', 400, 'Change your own name from your profile');
  }
  const name = body.name?.trim();
  const updated = await prisma.learner.update({
    where: { id: learner.id },
    data: {
      ...(name ? { name, avatarInitial: initialsOf(name) } : {}),
      ...(body.dob !== undefined ? { dob: body.dob ? parseDob(body.dob) : null } : {}),
      ...(body.gender !== undefined ? { gender: body.gender } : {}),
    },
  });
  return { learner: serializeLearner(updated, g.role) };
}

/** Archive, not delete: past attendance, payments and reviews still point at the learner. */
export async function archiveLearner(userId: string, learnerId: string) {
  await resolveLearner(userId, learnerId);
  const g = await prisma.guardianship.findUniqueOrThrow({ where: { userId_learnerId: { userId, learnerId } } });
  if (g.role === 'self') throw new AppError('VALIDATION', 400, 'Your own profile cannot be removed');

  const [activeEnrollments, openTrials] = await Promise.all([
    prisma.enrollment.count({ where: { learnerId, status: 'active' } }),
    prisma.trial.count({ where: { learnerId, status: 'booked' } }),
  ]);
  if (activeEnrollments > 0 || openTrials > 0) {
    throw new AppError(
      'LEARNER_IN_USE',
      409,
      'This child has an active class or an upcoming trial. Discontinue or cancel it first.',
    );
  }
  await prisma.learner.update({ where: { id: learnerId }, data: { status: 'archived' } });
  return { archived: true };
}

/** One card per learner: what they are enrolled in and their upcoming trials. */
export async function getDashboard(userId: string) {
  const { learners } = await listLearners(userId);
  const ids = learners.map((l) => l.id);
  const [enrollments, trials] = await Promise.all([
    prisma.enrollment.findMany({
      where: { learnerId: { in: ids }, status: 'active' },
      select: {
        id: true,
        learnerId: true,
        batch: { select: { id: true, title: true, mode: true, academy: { select: { id: true, name: true } } } },
      },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.trial.findMany({
      where: { learnerId: { in: ids }, status: 'booked', trialAt: { gte: new Date() } },
      select: {
        id: true,
        learnerId: true,
        trialAt: true,
        batch: { select: { id: true, title: true } },
        academy: { select: { id: true, name: true } },
      },
      orderBy: { trialAt: 'asc' },
    }),
  ]);
  return {
    learners: learners.map((l) => ({
      ...l,
      enrollments: enrollments
        .filter((e) => e.learnerId === l.id)
        .map((e) => ({
          id: e.id,
          batch_id: e.batch.id,
          batch_title: e.batch.title,
          mode: e.batch.mode,
          academy: e.batch.academy,
        })),
      upcoming_trials: trials
        .filter((t) => t.learnerId === l.id)
        .map((t) => ({
          id: t.id,
          trial_at: t.trialAt.toISOString(),
          batch_id: t.batch.id,
          batch_title: t.batch.title,
          academy: t.academy,
        })),
    })),
  };
}

/** One learner's attendance register, newest first. Archived learners stay readable. */
export async function getLearnerAttendance(userId: string, learnerId: string, month?: string) {
  const ids = await guardedLearnerIds(userId);
  if (!ids.includes(learnerId)) throw new AppError('NOT_FOUND', 404, 'Learner not found');

  let range: { from: Date; to: Date } | undefined;
  if (month) {
    try {
      range = monthRange(month);
    } catch {
      throw new AppError('VALIDATION', 400, 'month must be yyyy-MM');
    }
  }
  const rows = await prisma.batchAttendance.findMany({
    where: { learnerId, ...(range ? { date: { gte: range.from, lte: range.to } } : {}) },
    select: {
      date: true,
      present: true,
      method: true,
      batch: { select: { id: true, title: true, academy: { select: { id: true, name: true } } } },
    },
    orderBy: { date: 'desc' },
    take: 200,
  });
  const present = rows.filter((r) => r.present).length;
  return {
    learner_id: learnerId,
    present,
    total: rows.length,
    pct: rows.length ? Math.round((present / rows.length) * 100) : null,
    records: rows.map((r) => ({
      date: dateKey(r.date),
      present: r.present,
      method: r.method,
      batch_id: r.batch.id,
      batch_title: r.batch.title,
      academy: r.batch.academy,
    })),
  };
}
