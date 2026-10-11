import { prisma } from '../../lib/prisma.js';

// A program is BRAND-level, so reading one always needs a branch context to answer "where can
// I actually take this?". `academyId` scopes the batches — and therefore the price, the seats
// and the schedule — to one branch. Without it the caller gets every active batch across the
// brand, which is only correct for a brand-wide view.
export async function findProgramById(id: string, academyId?: string) {
  return prisma.program.findUnique({
    where: { id },
    include: {
      group: { select: { id: true, name: true, category: true } },
      media: { where: { hidden: false }, orderBy: { order: 'asc' } },
      // Only active batches are bookable / shown to learners.
      batches: {
        where: { status: 'active', ...(academyId ? { academyId } : {}) },
        include: {
          timings: true,
          coach: { select: { name: true } },
          academy: {
            select: {
              id: true,
              name: true,
              branchLabel: true,
              category: true,
              address: true,
              verified: true,
              rating: true,
              ratingCount: true,
              images: true,
            },
          },
          _count: { select: { enrollments: { where: { status: 'active' } } } },
        },
      },
    },
  });
}
