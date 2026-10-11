import { prisma } from '../../lib/prisma.js';
import type { Category } from '@prisma/client';

/**
 * Search-as-you-type across the three things a learner can actually open: an academy, a program,
 * and a workshop.
 *
 * Each query is capped on its own rather than sharing one budget, so a brand with fifty branches
 * cannot crowd every program out of the list — the panel shows a few of each kind, which is what
 * makes it scannable.
 *
 * Each kind carries the SAME predicate its own browse surface applies, so search is a faithful
 * index of what the app will actually open — suggesting a dead end is worse than not suggesting.
 * Note those predicates are not identical to each other: the academy list requires `verified`
 * while the workshop feed and the academy detail page do not. That inconsistency is the app's,
 * not this endpoint's, and it is deliberately mirrored rather than quietly tightened here —
 * tightening it would make search hide a workshop the feed on the next tab is still showing.
 */

const CONTAINS = (q: string) => ({ contains: q, mode: 'insensitive' as const });

export async function suggestAcademies(q: string, take: number) {
  return prisma.academy.findMany({
    where: {
      verified: true,
      OR: [{ name: CONTAINS(q) }, { specialities: { has: q } }, { address: CONTAINS(q) }],
    },
    orderBy: [{ rating: 'desc' }, { ratingCount: 'desc' }],
    take,
    select: {
      id: true,
      name: true,
      branchLabel: true,
      category: true,
      address: true,
      rating: true,
      ratingCount: true,
      images: true,
    },
  });
}

export async function suggestPrograms(q: string, take: number) {
  const rows = await prisma.program.findMany({
    where: {
      OR: [{ title: CONTAINS(q) }, { description: CONTAINS(q) }],
      // "Has an active batch somewhere" — the rule the academy page uses to decide which
      // programs it surfaces (academies/repo.ts §1.1: availability is derived, never stored).
      batches: { some: { status: 'active' } },
    },
    take,
    select: {
      id: true,
      title: true,
      category: true,
      level: true,
      media: { select: { url: true }, take: 1 },
      batches: {
        where: { status: 'active' },
        take: 1,
        orderBy: { monthlyFeePaise: 'asc' },
        select: { academy: { select: { id: true, name: true } } },
      },
    },
  });
  return rows.filter((p) => p.batches.length > 0);
}

export async function suggestWorkshops(q: string, take: number) {
  return prisma.workshop.findMany({
    where: {
      OR: [{ title: CONTAINS(q) }, { description: CONTAINS(q) }],
      // Exactly what GET /workshops serves: published, and not already over.
      status: 'upcoming',
      endAt: { gte: new Date() },
    },
    orderBy: { startAt: 'asc' },
    take,
    select: {
      id: true,
      title: true,
      category: true,
      startAt: true,
      coverImageUrl: true,
      academy: { select: { id: true, name: true } },
    },
  });
}

/** How many discoverable academies teach a given art form — the count on a category suggestion. */
export async function countAcademiesByCategory(category: Category) {
  return prisma.academy.count({ where: { verified: true, category } });
}

// ─── Trending ────────────────────────────────────────────────────────────────
//
// "Trending" is measured, not curated: it is what students in the last few weeks actually did.
// Two signals, because each is wrong on its own — a trial booking is the strongest statement of
// intent but is rare, while a save is frequent and cheap. Counting both gives a ranking that
// neither a single popular batch nor a burst of idle browsing can dominate.

/** How far back demand counts. Long enough to survive a quiet week, short enough to be "now". */
const TRENDING_WINDOW_DAYS = 30;

function windowStart() {
  return new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** Academy ids ranked by recent trial bookings + saves. Ids only — the caller hydrates. */
export async function trendingAcademyIds(take: number) {
  const since = windowStart();
  const [trials, saves] = await Promise.all([
    prisma.trial.groupBy({
      by: ['academyId'],
      where: { createdAt: { gte: since } },
      _count: { academyId: true },
    }),
    prisma.savedAcademy.groupBy({
      by: ['academyId'],
      where: { savedAt: { gte: since } },
      _count: { academyId: true },
    }),
  ]);

  const score = new Map<string, number>();
  // A trial is worth more than a save: one is a booking, the other is a bookmark.
  for (const t of trials) score.set(t.academyId, (score.get(t.academyId) ?? 0) + t._count.academyId * 3);
  for (const s of saves) score.set(s.academyId, (score.get(s.academyId) ?? 0) + s._count.academyId);

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, take)
    .map(([id]) => id);
}

/** Hydrate ranked ids, keeping the ranking and dropping anything no longer discoverable. */
export async function academiesByIds(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await prisma.academy.findMany({
    where: { id: { in: ids }, verified: true },
    select: {
      id: true,
      name: true,
      branchLabel: true,
      category: true,
      address: true,
      rating: true,
      images: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
}

/**
 * The programs students are actually enrolling in, most-enrolled first. This is what backs the
 * trending SEARCH TERMS — a term nobody could have searched for is not a suggestion, so they are
 * drawn from real catalogue titles rather than invented.
 */
export async function trendingProgramTitles(take: number, categories?: Category[]) {
  const rows = await prisma.program.findMany({
    where: {
      batches: { some: { status: 'active' } },
      ...(categories?.length ? { category: { in: categories } } : {}),
    },
    select: {
      title: true,
      category: true,
      _count: { select: { batches: true } },
    },
    orderBy: { batches: { _count: 'desc' } },
    take,
  });
  return rows;
}

/** Academies matching what the student said they were interested in at onboarding. */
export async function academiesForCategories(categories: Category[], take: number) {
  if (categories.length === 0) return [];
  return prisma.academy.findMany({
    where: { verified: true, category: { in: categories } },
    orderBy: [{ rating: 'desc' }, { ratingCount: 'desc' }],
    take,
    select: {
      id: true,
      name: true,
      branchLabel: true,
      category: true,
      address: true,
      rating: true,
      images: true,
    },
  });
}

export async function userInterests(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { interests: true, location: true } });
  return { interests: u?.interests ?? [], location: u?.location ?? null };
}
