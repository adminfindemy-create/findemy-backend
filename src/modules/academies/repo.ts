import { prisma } from '../../lib/prisma.js';

type Category = 'music' | 'dance' | 'arts' | 'yoga';

export async function findAcademyById(id: string) {
  return prisma.academy.findUnique({
    where: { id },
    include: {
      coaches: true,
      // Programs own the identity/marketing copy; a program is included only if it has
      // ≥1 active batch (filtered client-side in the service after grouping).
      programs: { include: { media: { orderBy: { order: 'asc' } } } },
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

export async function searchAcademies(args: {
  q?: string;
  category?: Category;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  online?: boolean;
  sort?: 'rating' | 'distance' | 'top_rated';
  limit: number;
  cursor?: { id: string; ts: string };
}) {
  const { q, category, online, sort, limit, cursor } = args;

  const where: Record<string, unknown> = {};
  if (category) where.category = category;
  if (q) where.name = { contains: q, mode: 'insensitive' };
  if (online != null) where.onlineAvailable = online;

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
