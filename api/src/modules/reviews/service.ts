import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { newId } from '../../lib/id.js';
import { sendPushNotifications } from '../push/service.js';

// Recompute academy rating + count from the FULL set — keeps the (cached) student-facing
// readers (search/detail/saved + the ranking sort) canonical. No partial/filtered query.
// Deleting the last review empties the set, so the average is guarded: fall back to 0
// rather than the NaN a divide-by-zero would write into the column.
async function recomputeAcademyRating(academyId: string) {
  const allReviews = await prisma.review.findMany({
    where: { academyId },
    select: { rating: true },
  });
  const avg = allReviews.length > 0 ? allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length : 0;
  await prisma.academy.update({
    where: { id: academyId },
    data: { rating: avg, ratingCount: allReviews.length },
  });
}

// S4.3: a review from an ATTENDED trial OR an enrolment. One review per (user, academy).
export async function createReview(
  userId: string,
  data: {
    source: 'trial' | 'enrollment';
    rating: number;
    comment?: string;
    // trial path: only trial_id needed (it pins academy+batch). enrolment path: academy_id+batch_id.
    trial_id?: string;
    academy_id?: string;
    batch_id?: string;
  },
) {
  let trialId: string | null = null;
  let enrollmentId: string | null = null;
  let academyId: string;
  let batchId: string;

  if (data.source === 'trial') {
    // Eligibility: the user ATTENDED this trial (owner decision: attended only). The trial
    // uniquely pins academy + batch — no multi-batch ambiguity, so derive them from it.
    const trial = await prisma.trial.findFirst({
      where: { id: data.trial_id, userId, status: 'attended' },
      select: { id: true, academyId: true, batchId: true },
    });
    if (!trial) throw new AppError('NOT_ELIGIBLE', 403, 'You can review only after attending a trial here.');
    trialId = trial.id;
    academyId = trial.academyId;
    batchId = trial.batchId;
  } else {
    // Eligibility: the user is/was enrolled in this specific batch at this academy.
    if (!data.academy_id || !data.batch_id) throw new AppError('VALIDATION', 400, 'academy_id and batch_id are required');
    const enr = await prisma.enrollment.findFirst({
      where: { userId, batchId: data.batch_id, batch: { academyId: data.academy_id } },
      select: { id: true },
    });
    if (!enr) throw new AppError('NOT_ELIGIBLE', 403, 'You can review only a batch you are enrolled in.');
    enrollmentId = enr.id;
    academyId = data.academy_id;
    batchId = data.batch_id;
  }

  let review;
  try {
    review = await prisma.review.create({
      data: {
        id: newId(),
        userId,
        academyId,
        batchId,
        source: data.source,
        trialId,
        enrollmentId,
        rating: data.rating,
        comment: data.comment,
      },
    });
  } catch (e: any) {
    // @@unique([userId, academyId]) → one review per academy from either path.
    if (e?.code === 'P2002') throw new AppError('ALREADY_REVIEWED', 409, 'You have already reviewed this academy.');
    throw e;
  }

  await recomputeAcademyRating(academyId);

  // S5.2: notify the academy of the new review (subjectId = academyId; push service resolves it).
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await sendPushNotifications({
      subjectId: academyId,
      subjectRole: 'academy',
      title: 'New review',
      body: `${u?.name ?? 'A student'} left a ${data.rating}★ review`,
      data: { screen: 'reviews' },
    });
  } catch {
    /* non-fatal */
  }

  return {
    review: {
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      created_at: review.createdAt.toISOString(),
    },
  };
}

// Rewrite your own review. Both fields are optional so a student can change the rating without
// retyping the note, or clear the note by sending an empty string.
//
// The academy's public reply is DROPPED on edit: a reply answers the specific review it was
// written under, and leaving a "thank you for the kind words" attached to a rewritten 1-star
// makes the academy say something it never said. The academy is notified so it can reply again.
export async function updateReview(
  userId: string,
  reviewId: string,
  data: { rating?: number; comment?: string },
) {
  // Scoped by userId for the same reason as delete: another student's review id is a 404 here.
  const existing = await prisma.review.findFirst({
    where: { id: reviewId, userId },
    select: { id: true, academyId: true, rating: true, comment: true, response: true },
  });
  if (!existing) throw new AppError('NOT_FOUND', 404, 'Review not found');

  const nextRating = data.rating ?? existing.rating;
  const nextComment = data.comment === undefined ? existing.comment : data.comment.trim() || null;
  const unchanged = nextRating === existing.rating && nextComment === existing.comment;
  // A no-op save must not stamp `editedAt` or wipe the academy's reply.
  if (unchanged) {
    return {
      review: {
        id: existing.id,
        rating: existing.rating,
        comment: existing.comment,
        edited: false,
      },
    };
  }

  const review = await prisma.review.update({
    where: { id: existing.id },
    data: {
      rating: nextRating,
      comment: nextComment,
      editedAt: new Date(),
      response: null,
      respondedAt: null,
      responseHidden: false,
    },
  });

  if (nextRating !== existing.rating) await recomputeAcademyRating(existing.academyId);

  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await sendPushNotifications({
      subjectId: existing.academyId,
      subjectRole: 'academy',
      title: existing.response ? 'A review you replied to was edited' : 'A review was edited',
      body: `${u?.name ?? 'A student'} updated their review to ${nextRating}\u2605`,
      data: { screen: 'reviews' },
    });
  } catch {
    /* non-fatal */
  }

  return {
    review: {
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      edited: true,
    },
  };
}

// Delete your own review. A hard delete, not a soft one: @@unique([userId, academyId]) means
// a tombstone would keep the slot occupied and lock the student out of ever reviewing this
// academy again. The academy's reply goes with it — a response has no meaning without the
// review it answers. To change a review rather than withdraw it, see `updateReview`.
export async function deleteReview(userId: string, reviewId: string) {
  // Scoped by userId, so someone else's review is a 404 here, never a 403 — the existence of
  // another student's review id is not something to confirm.
  const review = await prisma.review.findFirst({
    where: { id: reviewId, userId },
    select: { id: true, academyId: true },
  });
  if (!review) throw new AppError('NOT_FOUND', 404, 'Review not found');

  await prisma.review.delete({ where: { id: review.id } });
  await recomputeAcademyRating(review.academyId);

  // Deliberately no push to the academy: a withdrawn review is not news they can act on, and
  // the create-side notification already told them about it.
  return { deleted: true };
}

export async function getStudioReviews(academyId: string) {
  const reviews = await prisma.review.findMany({
    where: { academyId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { user: { select: { name: true } }, batch: { select: { title: true } } },
  });
  return {
    items: reviews.map((r) => ({
      id: r.id,
      student_name: r.user.name,
      rating: r.rating,
      comment: r.comment,
      response: r.response,
      created_at: r.createdAt.toISOString(),
      // A rewritten review dropped whatever reply was attached to it, so the academy needs to
      // see that this one changed rather than wonder where their response went.
      edited_at: r.editedAt?.toISOString() ?? null,
      batch_title: r.batch.title,
    })),
    next_cursor: null,
  };
}

export async function respondToReview(id: string, academyId: string, response: string) {
  const review = await prisma.review.findFirst({
    where: { id, academyId },
  });
  if (!review) throw new AppError('NOT_FOUND', 404, 'Review not found');

  await prisma.review.update({
    where: { id },
    data: { response, respondedAt: new Date() },
  });

  // S5.2: notify the student that the academy replied to their review.
  try {
    const academy = await prisma.academy.findUnique({ where: { id: academyId }, select: { name: true } });
    await sendPushNotifications({
      subjectId: review.userId,
      subjectRole: 'student',
      title: 'Academy replied to your review',
      body: `${academy?.name ?? 'The academy'} responded to your review`,
      data: { screen: 'academy', academy_id: academyId },
    });
  } catch {
    /* non-fatal */
  }

  return { review: { id } };
}
