import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { serializeAttendee } from '../../lib/tickets.js';
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
  return { items: rows.map((r) => r.academy) };
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
    items: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.createdAt.toISOString(),
      academy_name: r.academy.name,
      academy_id: r.academy.id,
      batch_title: r.batch.title,
    })),
  };
}

export async function getMyWorkshopRegistrations(userId: string) {
  const regs = await (prisma as any).workshopRegistration.findMany({
    where: { userId, status: 'confirmed' },
    include: {
      workshop: {
        include: { academy: { select: { id: true, name: true } } },
      },
      attendees: { orderBy: { position: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return {
    items: regs.map((r: any) => ({
      id: r.id,
      status: r.status,
      workshop_id: r.workshopId,
      workshop_title: r.workshop.title,
      workshop_type: r.workshop.type,
      workshop_cover_image_url: r.workshop.coverImageUrl ?? undefined,
      start_at: r.workshop.startAt.toISOString(),
      price_paise: r.workshop.pricePaise,
      quantity: r.quantity ?? 1,
      attendees: (r.attendees ?? []).map(serializeAttendee),
      academy_name: r.workshop.academy.name,
      academy_id: r.workshop.academy.id,
    })),
  };
}

export async function getMyEventRegistrations(userId: string) {
  const regs = await (prisma as any).eventRegistration.findMany({
    where: { userId, status: 'confirmed' },
    include: { event: true, attendees: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return {
    items: regs.map((r: any) => ({
      id: r.id,
      status: r.status,
      event_id: r.eventId,
      event_title: r.event.title,
      event_type: r.event.type,
      category: r.event.category,
      start_at: r.event.startAt.toISOString(),
      location: r.event.location,
      price_paise: r.event.pricePaise,
      quantity: r.quantity ?? 1,
      attendees: (r.attendees ?? []).map(serializeAttendee),
      organizer_name: r.event.organizerName,
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
    history: referrals.map((r) => ({
      id: r.id,
      referree_name: r.referree?.name ?? 'Someone',
      claimed_at: r.claimedAt?.toISOString(),
    })),
  };
}
