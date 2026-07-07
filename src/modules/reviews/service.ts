import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { newId } from '../../lib/id.js';
import { sendPushNotifications } from '../push/service.js';

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

  // Recompute academy rating + count from the FULL set — keeps the (cached) student-facing
  // readers (search/detail/saved + the ranking sort) canonical. No partial/filtered query.
  const allReviews = await prisma.review.findMany({
    where: { academyId },
    select: { rating: true },
  });
  const avg = allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length;
  await prisma.academy.update({
    where: { id: academyId },
    data: { rating: avg, ratingCount: allReviews.length },
  });

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
