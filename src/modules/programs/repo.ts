import { prisma } from '../../lib/prisma.js';

export async function findProgramById(id: string) {
  return prisma.program.findUnique({
    where: { id },
    include: {
      academy: {
        select: {
          id: true,
          name: true,
          category: true,
          address: true,
          verified: true,
          rating: true,
          ratingCount: true,
          images: true,
        },
      },
      media: { orderBy: { order: 'asc' } },
      // Only active batches are bookable / shown to learners.
      batches: {
        where: { status: 'active' },
        include: {
          timings: true,
          coach: { select: { name: true } },
          _count: { select: { enrollments: { where: { status: 'active' } } } },
        },
      },
    },
  });
}
