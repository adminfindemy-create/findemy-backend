import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { newId } from '../../lib/id.js';

// ---- Saved academies ----

export async function toggleSavedAcademy(userId: string, academyId: string) {
  const existing = await prisma.savedAcademy.findUnique({
    where: { userId_academyId: { userId, academyId } },
  });
  if (existing) {
    await prisma.savedAcademy.delete({ where: { userId_academyId: { userId, academyId } } });
    return { saved: false };
  }
  await prisma.savedAcademy.create({ data: { id: newId(), userId, academyId } });
  return { saved: true };
}

export async function getSavedAcademies(userId: string) {
  const rows = await prisma.savedAcademy.findMany({
    where: { userId },
    orderBy: { savedAt: 'desc' },
    include: {
      academy: {
        select: {
          id: true,
          name: true,
          category: true,
          address: true,
          rating: true,
          ratingCount: true,
          images: true,
          bio: true,
        },
      },
    },
  });
  return { items: rows.map((row) => row.academy) };
}

export async function isSavedAcademy(userId: string, academyId: string): Promise<boolean> {
  const row = await prisma.savedAcademy.findUnique({
    where: { userId_academyId: { userId, academyId } },
  });
  return !!row;
}

// ---- Referral ----

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export async function getReferral(userId: string) {
  let referral = await prisma.referral.findFirst({
    where: { referrerId: userId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });

  if (!referral) {
    let code: string;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
      if (attempts > 20) throw new AppError('INTERNAL', 500, 'Could not generate referral code');
    } while (await prisma.referral.findUnique({ where: { code } }));

    referral = await prisma.referral.create({
      data: { id: newId(), referrerId: userId, code },
    });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralPoints: true } });
  return { code: referral.code, points: user?.referralPoints ?? 0 };
}

export async function claimReferral(userId: string, code: string) {
  const referral = await prisma.referral.findUnique({ where: { code } });
  if (!referral) throw new AppError('NOT_FOUND', 404, 'Invalid referral code');
  if (referral.status !== 'pending') throw new AppError('VALIDATION', 400, 'Referral code already used');
  if (referral.referrerId === userId) throw new AppError('VALIDATION', 400, 'Cannot use your own referral code');

  const alreadyClaimed = await prisma.referral.findFirst({
    where: { referreeId: userId, status: 'claimed' },
  });
  if (alreadyClaimed) throw new AppError('VALIDATION', 400, 'You have already used a referral code');

  await prisma.$transaction([
    prisma.referral.update({
      where: { code },
      data: { referreeId: userId, status: 'claimed', claimedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: referral.referrerId },
      data: { referralPoints: { increment: 100 } },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { referralPoints: { increment: 50 } },
    }),
  ]);

  return { success: true, points_earned: 50 };
}

export async function getMyReviews(userId: string) {
  const reviews = await prisma.review.findMany({
    where: { userId },
    include: {
      academy: { select: { id: true, name: true } },
      batch: { select: { title: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return {
    items: reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      created_at: review.createdAt.toISOString(),
      academy_name: review.academy.name,
      academy_id: review.academy.id,
      batch_title: review.batch.title,
    })),
  };
}

export async function getMyWorkshopRegistrations(userId: string) {
  const registrations = await (prisma as any).workshopRegistration.findMany({
    where: { userId, status: 'confirmed' },
    include: {
      workshop: {
        include: { academy: { select: { id: true, name: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return {
    items: registrations.map((registration: any) => ({
      id: registration.id,
      status: registration.status,
      workshop_id: registration.workshopId,
      workshop_title: registration.workshop.title,
      workshop_type: registration.workshop.type,
      start_at: registration.workshop.startAt.toISOString(),
      price_paise: registration.workshop.pricePaise,
      academy_name: registration.workshop.academy.name,
      academy_id: registration.workshop.academy.id,
    })),
  };
}

export async function getMyEventRegistrations(userId: string) {
  const registrations = await (prisma as any).eventRegistration.findMany({
    where: { userId, status: 'confirmed' },
    include: { event: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return {
    items: registrations.map((registration: any) => ({
      id: registration.id,
      status: registration.status,
      event_id: registration.eventId,
      event_title: registration.event.title,
      event_type: registration.event.type,
      category: registration.event.category,
      start_at: registration.event.startAt.toISOString(),
      location: registration.event.location,
      price_paise: registration.event.pricePaise,
      organizer_name: registration.event.organizerName,
    })),
  };
}

export async function getReferralHistory(userId: string) {
  const referrals = await prisma.referral.findMany({
    where: { referrerId: userId, status: 'claimed' },
    orderBy: { claimedAt: 'desc' },
    include: { referree: { select: { name: true } } },
  });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralPoints: true } });

  return {
    points: user?.referralPoints ?? 0,
    history: referrals.map((referral) => ({
      id: referral.id,
      referree_name: referral.referree?.name ?? 'Someone',
      claimed_at: referral.claimedAt?.toISOString(),
    })),
  };
}
