import { prisma } from '../../lib/prisma.js';

type Category = 'music' | 'dance' | 'arts' | 'yoga';

// A BRANCH page. Programs and coaches are brand-level now, so neither can be read straight
// off the academy any more — both are filtered to "actually offered at THIS branch", i.e.
// has ≥1 active batch here. Without that filter Bandra advertises the Piano program (and the
// coach) that only Andheri teaches. See plan §1.1: availability is DERIVED, never stored.
export async function findAcademyById(id: string) {
  return prisma.academy.findUnique({
    where: { id },
    include: {
      group: {
        include: {
          // Programs own the identity/marketing copy. Included only when this branch runs an
          // active batch of them; the service additionally drops any that end up with zero
          // batches after wire-mapping.
          programs: {
            where: { batches: { some: { academyId: id, status: 'active' } } },
            include: { media: { where: { hidden: false }, orderBy: { order: 'asc' } } },
          },
          coaches: {
            where: { batches: { some: { academyId: id, status: 'active' } } },
          },
        },
      },
      // S1.3: active-enrollment count per batch → trialSpots = capacity − enrolled.
      batches: {
        where: { status: 'active' },
        include: {
          timings: true,
          coach: { select: { name: true } },
          _count: { select: { enrollments: { where: { status: 'active' } } } },
        },
      },
      reviews: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { name: true, avatarInitial: true } } },
      },
    },
  });
}

// The brand's OTHER branches — the "Other locations" section on a branch page. Only
// discoverable (approved) siblings, and never the branch you are already looking at.
export async function findSiblingBranches(groupId: string, excludeAcademyId: string) {
  return prisma.academy.findMany({
    where: { groupId, verified: true, id: { not: excludeAcademyId } },
    select: {
      id: true,
      name: true,
      branchLabel: true,
      address: true,
      lat: true,
      lng: true,
      rating: true,
      ratingCount: true,
      images: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

// Brand-wide rating aggregate, for a NEW branch with no reviews of its own. Presented in copy
// ("New location · XYZ Academy rated 4.6★ across 3 branches") and deliberately NOT written
// into `Academy.rating`: that column is what `min_rating` filters and `sort: 'rating'` orders
// on, so inheriting it would make an untested location sortable as if it were proven.
export async function findGroupRating(groupId: string) {
  const branches = await prisma.academy.findMany({
    where: { groupId, verified: true, ratingCount: { gt: 0 } },
    select: { rating: true, ratingCount: true },
  });
  const count = branches.reduce((sum, b) => sum + b.ratingCount, 0);
  if (count === 0) return { rating: 0, rating_count: 0, branch_count: 0 };
  const weighted = branches.reduce((sum, b) => sum + b.rating * b.ratingCount, 0);
  return {
    rating: Math.round((weighted / count) * 10) / 10,
    rating_count: count,
    branch_count: branches.length,
  };
}

// Everything the academy page needs to decide whether the viewer may review it: the review
// they already left (one per user+academy), an ATTENDED trial here, and an enrolment in one of
// this academy's batches. Enrolment is not filtered by status — `reviews.createReview` lets a
// former student review too, and the two checks must not drift apart.
export async function findReviewContext(academyId: string, userId: string) {
  const [myReview, trial, enrollment] = await Promise.all([
    prisma.review.findUnique({
      where: { userId_academyId: { userId, academyId } },
      select: { id: true, rating: true, comment: true, createdAt: true, editedAt: true },
    }),
    prisma.trial.findFirst({
      where: { userId, academyId, status: 'attended' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, batchId: true },
    }),
    prisma.enrollment.findFirst({
      where: { userId, batch: { academyId } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, batchId: true },
    }),
  ]);
  return { myReview, trial, enrollment };
}

export async function findAcademyReviews(
  academyId: string,
  cursor?: { id: string; ts: string },
  limit = 20,
) {
  return prisma.review.findMany({
    where: { academyId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    cursor: cursor ? { id: cursor.id } : undefined,
    skip: cursor ? 1 : 0,
    include: { user: { select: { name: true, avatarInitial: true } } },
  });
}

/** Every discoverable academy's art forms and position — the input to per-category counts. */
export async function findDiscoverableCategories() {
  return prisma.academy.findMany({
    where: { verified: true },
    select: { category: true, categories: true, lat: true, lng: true },
  });
}

export async function searchAcademies(args: {
  q?: string;
  category?: Category;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  online?: boolean;
  ageMin?: number;
  ageMax?: number;
  sort?: 'rating' | 'distance' | 'top_rated';
  limit: number;
  cursor?: { id: string; ts: string };
}) {
  const { q, category, online, ageMin, ageMax, sort, limit, cursor } = args;

  const where: Record<string, unknown> = {};
  // Only approved academies are discoverable. `verified` mirrors status==approved, so this also
  // hides pending/rejected academies and freezes suspended ones out of discovery (Ops Console).
  where.verified = true;
  // Match the art form against everything the branch teaches, not just its headline one —
  // a studio listed as music that also runs dance has to appear under Dance. `categories`
  // always contains the primary (enforced in studio.updateAcademy), so this is a superset
  // of the old `category` equality.
  // The primary `category` is matched too: rows written before `categories` existed (and the
  // seed) carry an empty array, and matching only `categories` hid them from every art form.
  if (category) where.OR = [{ category }, { categories: { has: category } }];
  if (q) where.name = { contains: q, mode: 'insensitive' };
  if (online != null) where.onlineAvailable = online;
  // Age fit is a property of batches, not the academy: keep the branch if ANY active batch's
  // range overlaps the learner bracket. Null bounds are open-ended on both sides (both null on a
  // batch = all ages, see Batch.minAge). Done in the query, not after, so pagination stays right.
  if (ageMin != null || ageMax != null) {
    where.batches = {
      some: {
        status: 'active',
        AND: [
          ageMax != null ? { OR: [{ minAge: null }, { minAge: { lte: ageMax } }] } : {},
          ageMin != null ? { OR: [{ maxAge: null }, { maxAge: { gte: ageMin } }] } : {},
        ],
      },
    };
  }

  const orderBy: Array<Record<string, string>> =
    sort === 'rating' || sort === 'top_rated'
      ? [{ rating: 'desc' }, { id: 'desc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }];

  const academies = await prisma.academy.findMany({
    where,
    orderBy,
    take: limit + 1,
    cursor: cursor ? { id: cursor.id } : undefined,
    skip: cursor ? 1 : 0,
    include: { batches: { select: { trialFeePaise: true, monthlyFeePaise: true } } },
  });

  return academies.map((a) => ({
    ...a,
    distance_km: null as number | null,
  }));
}
