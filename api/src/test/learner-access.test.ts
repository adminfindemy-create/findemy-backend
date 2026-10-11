import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The family-accounts guard. Every student route that names a learner goes through
 * `resolveLearner`, and every academy route that names a student goes through
 * `learnerIdFromStudentRef` — a mistake in either is one family reading or booking for
 * another's child. See ai-usage/final-app/plan/family-accounts.md.
 */

const db = {
  users: [] as { id: string; selfLearnerId: string | null; age: number | null }[],
  learners: [] as { id: string; name: string; status: string; dob: Date | null; gender: string | null }[],
  guardianships: [] as { userId: string; learnerId: string }[],
};

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        const u = where.id
          ? db.users.find((x) => x.id === where.id)
          : db.users.find((x) => x.selfLearnerId === where.selfLearnerId);
        return u ?? null;
      }),
    },
    guardianship: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { userId, learnerId } = where.userId_learnerId;
        const g = db.guardianships.find((x) => x.userId === userId && x.learnerId === learnerId);
        if (!g) return null;
        return { ...g, learner: db.learners.find((l) => l.id === learnerId) };
      }),
    },
  },
}));

const { resolveLearner, learnerIdFromStudentRef, assertLearnerFitsBatch, ageOn, studentCard, whose } = await import(
  '../lib/learner-access.js'
);

const learner = (id: string, extra: Partial<(typeof db.learners)[number]> = {}) => ({
  id,
  name: id,
  status: 'active',
  dob: null,
  gender: null,
  ...extra,
});

beforeEach(() => {
  db.users = [
    { id: 'varun', selfLearnerId: 'varun-self', age: 38 },
    { id: 'other', selfLearnerId: 'other-self', age: 30 },
  ];
  db.learners = [
    learner('varun-self'),
    learner('aarav'),
    learner('old-child', { status: 'archived' }),
    learner('other-self'),
    learner('other-child'),
  ];
  db.guardianships = [
    { userId: 'varun', learnerId: 'varun-self' },
    { userId: 'varun', learnerId: 'aarav' },
    { userId: 'varun', learnerId: 'old-child' },
    { userId: 'other', learnerId: 'other-self' },
    { userId: 'other', learnerId: 'other-child' },
  ];
});

describe('resolveLearner', () => {
  it('falls back to the account holder when no learner is named (old app builds)', async () => {
    expect((await resolveLearner('varun')).id).toBe('varun-self');
  });

  it("returns the caller's own child", async () => {
    expect((await resolveLearner('varun', 'aarav')).id).toBe('aarav');
  });

  it("404s on another family's child, never 403", async () => {
    await expect(resolveLearner('varun', 'other-child')).rejects.toMatchObject({ status: 404 });
  });

  it('404s on an archived child', async () => {
    await expect(resolveLearner('varun', 'old-child')).rejects.toMatchObject({ status: 404 });
  });

  it('404s on a user id passed as a learner id', async () => {
    await expect(resolveLearner('varun', 'other')).rejects.toMatchObject({ status: 404 });
  });
});

describe('learnerIdFromStudentRef (academy requests)', () => {
  it('uses learner_id as given', async () => {
    expect(await learnerIdFromStudentRef({ learner_id: 'aarav', user_id: 'varun' })).toBe('aarav');
  });

  it("maps an old academy build's user_id to that account's own learner", async () => {
    expect(await learnerIdFromStudentRef({ user_id: 'varun' })).toBe('varun-self');
  });

  it('treats an unknown user_id as a learner id (newer client, old field)', async () => {
    expect(await learnerIdFromStudentRef({ user_id: 'aarav' })).toBe('aarav');
  });

  it('400s when neither is sent', async () => {
    await expect(learnerIdFromStudentRef({})).rejects.toMatchObject({ status: 400 });
  });
});

describe('assertLearnerFitsBatch', () => {
  const on = new Date();
  const yearsAgo = (n: number) => new Date(Date.UTC(on.getUTCFullYear() - n, 0, 1));
  const batch = (b: Partial<{ minAge: number | null; maxAge: number | null; gender: string }> = {}) => ({
    minAge: null,
    maxAge: null,
    gender: 'anyone',
    ...b,
  });

  it('blocks a child under the minimum age', async () => {
    await expect(
      assertLearnerFitsBatch({ id: 'aarav', dob: yearsAgo(5), gender: null }, batch({ minAge: 8 })),
    ).rejects.toMatchObject({ code: 'AGE_MISMATCH', status: 422 });
  });

  it('blocks a learner over the maximum age', async () => {
    await expect(
      assertLearnerFitsBatch({ id: 'aarav', dob: yearsAgo(15), gender: null }, batch({ maxAge: 12 })),
    ).rejects.toMatchObject({ code: 'AGE_MISMATCH' });
  });

  it('blocks a boy from a female-only batch', async () => {
    await expect(
      assertLearnerFitsBatch({ id: 'aarav', dob: yearsAgo(10), gender: 'male' }, batch({ gender: 'female_only' })),
    ).rejects.toMatchObject({ code: 'GENDER_MISMATCH' });
  });

  it('lets an unknown gender into a female-only batch', async () => {
    await expect(
      assertLearnerFitsBatch({ id: 'aarav', dob: yearsAgo(10), gender: null }, batch({ gender: 'female_only' })),
    ).resolves.toBeUndefined();
  });

  it("uses the account's onboarding age for a self learner with no DOB", async () => {
    await expect(
      assertLearnerFitsBatch({ id: 'varun-self', dob: null, gender: null }, batch({ maxAge: 30 })),
    ).rejects.toMatchObject({ code: 'AGE_MISMATCH' });
  });

  it('lets a learner of unknown age through', async () => {
    await expect(
      assertLearnerFitsBatch({ id: 'aarav', dob: null, gender: null }, batch({ minAge: 8 })),
    ).resolves.toBeUndefined();
  });
});

describe('ageOn', () => {
  it('counts a birthday only once it has passed', () => {
    expect(ageOn(new Date('2016-06-15T00:00:00Z'), new Date('2026-06-14T00:00:00Z'))).toBe(9);
    expect(ageOn(new Date('2016-06-15T00:00:00Z'), new Date('2026-06-15T00:00:00Z'))).toBe(10);
  });
});

describe('studentCard (academy view)', () => {
  it("shows a child's name and age with the parent's phone", () => {
    const card = studentCard(
      { name: 'Varun', phone: '+919999900000', age: 38 },
      { id: 'aarav', name: 'Aarav', dob: new Date(Date.UTC(new Date().getUTCFullYear() - 9, 0, 1)) },
    );
    expect(card).toMatchObject({ learner_id: 'aarav', name: 'Aarav', age: 9, phone: '+919999900000', guardian_name: 'Varun' });
  });

  it("uses the account's age for a self learner", () => {
    expect(studentCard({ name: 'Priya', age: 24 }, { id: 'p', name: 'Priya', dob: null }).age).toBe(24);
  });
});

describe('whose (push wording)', () => {
  it('names a child', () => {
    expect(whose({ name: 'Aarav', selfOf: null })).toBe("Aarav's");
  });

  it('says "Your" for the account holder, and when the learner is unknown', () => {
    expect(whose({ name: 'Varun', selfOf: { id: 'varun' } })).toBe('Your');
    expect(whose(null)).toBe('Your');
    expect(whose(null, { lower: true })).toBe('your');
  });
});
