import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { writeAudit } from './audit.js';

// Moderation = soft-hide user/academy content from public view. Reversible + audited. The rating
// on a review is always kept; only the free-text comment/response can be hidden. Program media is
// hidden via a flag (excluded from public reads); academy hero images are removed from the array.

// ---------- Reviews ----------

export async function listReviews(filter: 'all' | 'hidden' = 'all') {
  const where =
    filter === 'hidden'
      ? { OR: [{ commentHidden: true }, { responseHidden: true }] }
      : { OR: [{ comment: { not: null } }, { response: { not: null } }] };

  const reviews = await prisma.review.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      user: { select: { name: true } },
      academy: { select: { name: true } },
      batch: { select: { title: true } },
    },
  });
  return {
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      response: r.response,
      comment_hidden: r.commentHidden,
      response_hidden: r.responseHidden,
      student_name: r.user.name,
      academy_name: r.academy.name,
      batch_title: r.batch.title,
      created_at: r.createdAt.toISOString(),
    })),
  };
}

export async function setReviewFieldHidden(
  actorId: string,
  reviewId: string,
  field: 'comment' | 'response',
  hidden: boolean,
) {
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review) throw new AppError('NOT_FOUND', 404, 'Review not found');
  const updated = await prisma.review.update({
    where: { id: reviewId },
    data: field === 'comment' ? { commentHidden: hidden } : { responseHidden: hidden },
  });
  await writeAudit({
    adminId: actorId,
    action: `review.${field}_${hidden ? 'hide' : 'unhide'}`,
    targetType: 'Review',
    targetId: reviewId,
    extra: { academyId: review.academyId },
  });
  return {
    review: { id: updated.id, comment_hidden: updated.commentHidden, response_hidden: updated.responseHidden },
  };
}

// ---------- Media (program media + academy hero images) ----------

export async function getAcademyMedia(academyId: string) {
  const academy = await prisma.academy.findUnique({
    where: { id: academyId },
    select: {
      id: true,
      name: true,
      images: true,
      // Programs are BRAND-level, so a branch's moderation queue reaches them through the
      // group. Scoped to programs this branch actually runs, matching what a learner can see
      // on this branch's page (plan §1.1) — hiding media is otherwise done against a program
      // the reported location does not even offer.
      group: {
        select: {
          programs: {
            where: { batches: { some: { academyId, status: 'active' } } },
            select: {
              id: true,
              title: true,
              media: { orderBy: { order: 'asc' }, select: { id: true, url: true, type: true, hidden: true } },
            },
          },
        },
      },
    },
  });
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  return {
    academy_id: academy.id,
    academy_name: academy.name,
    images: academy.images,
    programs: academy.group.programs.map((p) => ({
      id: p.id,
      title: p.title,
      media: p.media.map((m) => ({ id: m.id, url: m.url, type: m.type, hidden: m.hidden })),
    })),
  };
}

export async function setMediaHidden(actorId: string, mediaId: string, hidden: boolean) {
  const media = await prisma.programMedia.findUnique({ where: { id: mediaId }, include: { program: { select: { groupId: true } } } });
  if (!media) throw new AppError('NOT_FOUND', 404, 'Media not found');
  await prisma.programMedia.update({ where: { id: mediaId }, data: { hidden } });
  await writeAudit({
    adminId: actorId,
    action: `media.${hidden ? 'hide' : 'unhide'}`,
    targetType: 'ProgramMedia',
    targetId: mediaId,
    extra: { groupId: media.program.groupId, programId: media.programId, url: media.url },
  });
  return { id: mediaId, hidden };
}

// Academy hero images are a String[] — moderation removes the URL from the array.
export async function removeAcademyImage(actorId: string, academyId: string, url: string) {
  const academy = await prisma.academy.findUnique({ where: { id: academyId }, select: { images: true } });
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  if (!academy.images.includes(url)) throw new AppError('BAD_REQUEST', 400, 'Image not found on this academy');
  const nextImages = academy.images.filter((i) => i !== url);
  await prisma.academy.update({ where: { id: academyId }, data: { images: nextImages } });
  await writeAudit({
    adminId: actorId,
    action: 'academy.image_remove',
    targetType: 'Academy',
    targetId: academyId,
    before: { images: academy.images },
    after: { images: nextImages },
    extra: { removedUrl: url },
  });
  return { images: nextImages };
}
