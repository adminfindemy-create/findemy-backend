import type { Category, BatchMode } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { istDateKey, istWallClockToUtc } from '../../lib/ist.js';
import { toWireMode } from '../../lib/mode.js';
import { type AttendanceTier, attendancePct, expectedSessions, tierOf } from '../../lib/attendance-tier.js';

export async function getDashboardStats(academyId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  // Gross for a window = trial + enrolment + workshop captured revenue (matches the Earnings
  // screen's scope, so the dashboard card and the Earnings detail agree).
  const grossFor = async (from: Date, to?: Date) => {
    const capturedAt = to ? { gte: from, lte: to } : { gte: from };
    const [trial, enrol, workshop] = await Promise.all([
      prisma.payment.aggregate({
        _sum: { amountPaise: true },
        where: { booking: { batch: { academyId } }, status: 'captured', capturedAt },
      }),
      prisma.enrollmentPayment.aggregate({
        _sum: { amountPaise: true },
        where: { enrollmentPeriod: { enrollment: { batch: { academyId } } }, status: 'captured', capturedAt },
      }),
      prisma.workshopPayment.aggregate({
        _sum: { amountPaise: true },
        where: { registration: { workshop: { academyId } }, status: 'captured', capturedAt },
      }),
    ]);
    return (trial._sum.amountPaise ?? 0) + (enrol._sum.amountPaise ?? 0) + (workshop._sum.amountPaise ?? 0);
  };

  const [
    newCount,
    pendingCount,
    confirmedCount,
    activeTrials,
    studentsCount,
    thisMonthGross,
    lastMonthGross,
    recentReviews,
    thisMonthCommission,
    lastMonthCommission,
  ] = await Promise.all([
    prisma.trial.count({ where: { academyId, status: 'booked' } }),
    prisma.trial.count({ where: { academyId, status: 'booked', trialAt: { gte: now } } }),
    prisma.trial.count({ where: { academyId, status: 'attended' } }),
    prisma.trial.count({
      where: {
        academyId,
        status: { in: ['booked', 'attended'] },
        trialAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.enrollment.count({ where: { batch: { academyId } } }),
    grossFor(startOfMonth),
    grossFor(startOfLastMonth, endOfLastMonth),
    prisma.review.findMany({
      where: { academyId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { user: { select: { name: true } } },
    }),
    // S4.6: commission accrued this/last month across all sources (same scope as gross above).
    prisma.commissionLedger.aggregate({
      _sum: { commissionPaise: true, reversedPaise: true },
      where: { academyId, status: 'accrued', createdAt: { gte: startOfMonth } },
    }),
    prisma.commissionLedger.aggregate({
      _sum: { commissionPaise: true, reversedPaise: true },
      where: { academyId, status: 'accrued', createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } },
    }),
  ]);

  // S4.6: net = gross − (commission − reversed).
  const thisMonthComm = (thisMonthCommission._sum.commissionPaise ?? 0) - (thisMonthCommission._sum.reversedPaise ?? 0);
  const lastMonthComm = (lastMonthCommission._sum.commissionPaise ?? 0) - (lastMonthCommission._sum.reversedPaise ?? 0);

  return {
    inbox_counts: { new: newCount, pending: pendingCount, confirmed: confirmedCount },
    active_trials: activeTrials,
    earnings_summary: {
      this_month_paise: thisMonthGross, // back-compat = gross
      this_month_gross_paise: thisMonthGross,
      this_month_commission_paise: thisMonthComm,
      this_month_net_paise: thisMonthGross - thisMonthComm,
      last_month_paise: lastMonthGross,
      last_month_net_paise: lastMonthGross - lastMonthComm,
    },
    students_count: studentsCount,
    recent_reviews: recentReviews.map((review) => ({
      id: review.id,
      student_name: review.user.name,
      rating: review.rating,
      comment: review.comment,
      response: review.response,
      created_at: review.createdAt.toISOString(),
    })),
  };
}

export async function getInboxItems(academyId: string, status?: string, limit = 20) {
  const where: Record<string, unknown> = { academyId };
  if (status && status !== 'all') {
    if (status === 'new') where.status = 'booked';
    else if (status === 'pending') where.status = 'booked';
    else if (status === 'confirmed') where.status = 'attended';
    else where.status = status;
  }

  const items = await prisma.trial.findMany({
    where,
    orderBy: { trialAt: 'asc' },
    take: limit,
    include: {
      user: { select: { name: true, phone: true, age: true } },
      batch: {
        select: {
          title: true,
          level: true,
          category: true,
          trialFeePaise: true,
          coach: { select: { name: true } },
        },
      },
    },
  });

  const counts = {
    new: await prisma.trial.count({ where: { academyId, status: 'booked' } }),
    pending: await prisma.trial.count({ where: { academyId, status: 'booked', trialAt: { gte: new Date() } } }),
    confirmed: await prisma.trial.count({ where: { academyId, status: 'attended' } }),
  };

  return { items, counts };
}

export async function getTrialDetail(id: string, academyId: string) {
  return prisma.trial.findFirst({
    where: { id, academyId },
    include: {
      user: { select: { id: true, name: true, phone: true, age: true, location: true, attendanceOtp: true } },
      batch: { select: { title: true, category: true, level: true, mode: true, trialFeePaise: true } },
      booking: { select: { status: true, createdAt: true, payment: { select: { status: true } } } },
    },
  });
}

export async function getActivity(academyId: string, limit = 12) {
  const [attendedTrials, reviews, enrollments, workshopRegs] = await Promise.all([
    prisma.trial.findMany({
      where: { academyId, status: 'attended' },
      orderBy: { attendanceMarkedAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } }, batch: { select: { title: true } } },
    }),
    prisma.review.findMany({
      where: { academyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } } },
    }),
    prisma.enrollment.findMany({
      where: { batch: { academyId }, status: 'active' },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } }, batch: { select: { title: true } } },
    }),
    prisma.workshopRegistration.findMany({
      where: { workshop: { academyId } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } }, workshop: { select: { title: true } } },
    }),
  ]);
  return { attendedTrials, reviews, enrollments, workshopRegs };
}

// S3.4: the schedule is projected from each active batch's weekly BatchTiming (slots retired,
// D1), with CancelledSession overlaid as the `cancelled` status. No slot_id.
export async function getSchedule(academyId: string, weekStart: Date) {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const [batches, cancelled] = await Promise.all([
    prisma.batch.findMany({
      where: { academyId, status: 'active' },
      select: {
        id: true,
        title: true,
        category: true,
        capacity: true,
        mode: true,
        coach: { select: { name: true } },
        timings: true,
        _count: { select: { enrollments: { where: { status: 'active' } } } },
      },
    }),
    prisma.cancelledSession.findMany({
      where: { batch: { academyId }, sessionDate: { gte: weekStart, lt: weekEnd } },
      select: { batchId: true, sessionDate: true },
    }),
  ]);

  const cancelledSet = new Set(cancelled.map((cancelledSession) => `${cancelledSession.batchId}:${istDateKey(cancelledSession.sessionDate)}`));
  const now = new Date();
  const days: Record<string, any[]> = {};

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dateStr = istDateKey(new Date(weekStart.getTime() + dayOffset * 86400000));
    const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    for (const batch of batches) {
      for (const timing of batch.timings) {
        if (timing.dayOfWeek !== dow) continue;
        const [hour, minute] = timing.startTime.split(':').map(Number);
        const start = istWallClockToUtc(dateStr, hour, minute);
        const end = new Date(start.getTime() + timing.durationMin * 60_000);
        let status: string;
        if (cancelledSet.has(`${batch.id}:${dateStr}`)) status = 'cancelled';
        else if (now >= start && now <= end) status = 'now';
        else if (now < start) status = 'upcoming';
        else status = 'done';

        if (!days[dateStr]) days[dateStr] = [];
        days[dateStr].push({
          batch_id: batch.id,
          session_date: dateStr,
          batch_title: batch.title,
          category: batch.category,
          capacity: batch.capacity,
          enrolled_count: batch._count.enrollments,
          coach_name: batch.coach?.name ?? null,
          mode: toWireMode(batch.mode),
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          status,
        });
      }
    }
  }

  return Object.entries(days)
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, items]) => ({ date, items: items.sort((itemA, itemB) => itemA.start_time.localeCompare(itemB.start_time)) }));
}

// S1.3: include active-enrollment count so the serializer can derive trialSpots = capacity − enrolled.
const ACTIVE_ENROLLMENT_COUNT = { _count: { select: { enrollments: { where: { status: 'active' as const } } } } };

export async function getBatches(academyId: string) {
  return prisma.batch.findMany({
    where: { academyId },
    include: { coach: { select: { name: true } }, timings: true, ...ACTIVE_ENROLLMENT_COUNT },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getBatchById(id: string, academyId: string) {
  return prisma.batch.findFirst({
    where: { id, academyId },
    include: { coach: { select: { name: true } }, timings: true, ...ACTIVE_ENROLLMENT_COUNT },
  });
}

export async function createBatch(data: {
  academyId: string;
  programId: string;
  coachId: string;
  title: string;
  category: string;
  level: string;
  description?: string;
  thingsToKnow?: string[];
  capacity: number;
  trialFeePaise: number;
  monthlyFeePaise: number;
  quarterlyDiscountBps?: number;
  annualDiscountBps?: number;
  mode?: string;
}) {
  // `category`/`mode` are validated/mapped upstream; the casts align with Prisma's
  // generated enum inputs (FKs are unchecked scalars). programId is required — every batch
  // is created under a program (the service resolves + validates it).
  const { mode, ...rest } = data;
  return prisma.batch.create({
    data: {
      ...rest,
      category: data.category as Category,
      ...(mode ? { mode: mode as BatchMode } : {}),
    },
  });
}

// --- Programs (academy-authored offerings that own batches) ---

export async function getPrograms(academyId: string) {
  return prisma.program.findMany({
    where: { academyId },
    include: {
      _count: { select: { batches: true } },
      media: { orderBy: { order: 'asc' }, take: 1 }, // cover only for the list
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getProgramById(id: string, academyId: string) {
  return prisma.program.findFirst({
    where: { id, academyId },
    include: {
      media: { orderBy: { order: 'asc' } },
      batches: {
        include: { coach: { select: { name: true } }, timings: true, ...ACTIVE_ENROLLMENT_COUNT },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
}

type MediaInput = { url: string; type: string }[];

export async function createProgram(data: {
  academyId: string;
  title: string;
  category: string;
  description?: string;
  thingsToKnow?: string[];
  media?: MediaInput;
}) {
  return prisma.program.create({
    data: {
      academyId: data.academyId,
      title: data.title,
      category: data.category as Category,
      description: data.description,
      thingsToKnow: data.thingsToKnow ?? [],
      media: data.media?.length
        ? { create: data.media.map((m, i) => ({ url: m.url, type: m.type, order: i })) }
        : undefined,
    },
  });
}

export async function updateProgram(
  id: string,
  academyId: string,
  data: Record<string, unknown>,
  media?: MediaInput,
) {
  // Ownership check (updateMany can't be scoped through a relation replace).
  const owned = await prisma.program.findFirst({ where: { id, academyId }, select: { id: true } });
  if (!owned) return { count: 0 };
  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) {
      await tx.program.update({ where: { id }, data });
    }
    if (media) {
      // Full replace: drop existing media rows, recreate in order.
      await tx.programMedia.deleteMany({ where: { programId: id } });
      await tx.programMedia.createMany({ data: media.map((m, i) => ({ programId: id, url: m.url, type: m.type, order: i })) });
    }
  });
  return { count: 1 };
}

export async function countProgramBatches(programId: string) {
  return prisma.batch.count({ where: { programId } });
}

export async function deleteProgram(id: string, academyId: string) {
  return prisma.program.deleteMany({ where: { id, academyId } });
}

export async function updateBatch(id: string, academyId: string, data: Record<string, unknown>) {
  return prisma.batch.updateMany({
    where: { id, academyId },
    data,
  });
}

export async function replaceBatchTimings(
  batchId: string,
  timings: { dayOfWeek: number; startTime: string; durationMin: number }[],
) {
  await prisma.$transaction([
    prisma.batchTiming.deleteMany({ where: { batchId } }),
    ...(timings.length
      ? [prisma.batchTiming.createMany({ data: timings.map((t) => ({ batchId, ...t })) })]
      : []),
  ]);
}

export async function deleteBatch(id: string, academyId: string) {
  const batch = await prisma.batch.findFirst({ where: { id, academyId } });
  if (!batch) return;
  await prisma.$transaction([
    prisma.review.deleteMany({ where: { batchId: id } }),
    prisma.trial.deleteMany({ where: { batchId: id } }),
    prisma.payment.deleteMany({ where: { booking: { batchId: id } } }),
    prisma.booking.deleteMany({ where: { batchId: id } }),
    prisma.enrollment.deleteMany({ where: { batchId: id } }),
    prisma.batchAttendance.deleteMany({ where: { batchId: id } }),
    prisma.slot.deleteMany({ where: { batchId: id } }),
    prisma.batchTiming.deleteMany({ where: { batchId: id } }),
    prisma.batch.deleteMany({ where: { id, academyId } }),
  ]);
}

export async function getStudents(
  academyId: string,
  q?: string,
  limit = 20,
  batchId?: string,
  attendanceTier?: AttendanceTier,
) {
  const batchWhere: any = { academyId };
  if (batchId) batchWhere.id = batchId;

  const where: any = { batch: batchWhere, status: 'active' };
  if (q) where.user = { name: { contains: q, mode: 'insensitive' } };

  const enrollments = await prisma.enrollment.findMany({
    where,
    include: {
      user: { select: { id: true, name: true, phone: true, age: true } },
      batch: { select: { id: true, title: true, category: true, sessionsPerMonth: true } },
    },
  });

  // S4.1: present counts per (user, batch) — scoped to the relevant batch(es), not all batches.
  const present = await prisma.batchAttendance.groupBy({
    by: ['userId', 'batchId'],
    where: { present: true, batch: batchWhere, userId: { in: enrollments.map((enrollment) => enrollment.userId) } },
    _count: true,
  });
  const presentMap = new Map<string, number>();
  for (const row of present) presentMap.set(`${row.userId}:${row.batchId}`, row._count);

  // % = present / EXPECTED (sessionsPerMonth × months enrolled); tier from one shared helper.
  const now = new Date();
  const withTier = enrollments.map((enrollment) => {
    const presentCount = presentMap.get(`${enrollment.userId}:${enrollment.batchId}`) ?? 0;
    const pct = attendancePct(presentCount, expectedSessions(enrollment.batch.sessionsPerMonth, enrollment.startedAt, now));
    return { ...enrollment, attendance_pct: pct, tier: tierOf(pct) };
  });

  const filtered = attendanceTier ? withTier.filter((enrollment) => enrollment.tier === attendanceTier) : withTier;
  return filtered.slice(0, limit);
}

export async function getBatchStudents(batchId: string, academyId: string) {
  const enrollments = await prisma.enrollment.findMany({
    where: { batchId, batch: { academyId }, status: 'active' },
    include: {
      user: { select: { id: true, name: true, phone: true, age: true } },
      batch: { select: { sessionsPerMonth: true } },
    },
  });

  const userIds = enrollments.map((enrollment) => enrollment.userId);
  // S4.1: present counts for this batch (only present rows are written — see attendance-tier.ts).
  const present = await prisma.batchAttendance.groupBy({
    by: ['userId'],
    where: { batchId, present: true, userId: { in: userIds } },
    _count: true,
  });
  const presentMap = new Map<string, number>(present.map((row) => [row.userId, row._count]));

  const lastSeen = await prisma.batchAttendance.findMany({
    where: { batchId, userId: { in: userIds }, present: true },
    orderBy: { date: 'desc' },
    distinct: ['userId'],
    select: { userId: true, date: true },
  });
  const lastSeenMap = new Map(lastSeen.map((row) => [row.userId, row.date]));

  const now = new Date();
  return enrollments.map((enrollment) => {
    const pct = attendancePct(presentMap.get(enrollment.userId) ?? 0, expectedSessions(enrollment.batch.sessionsPerMonth, enrollment.startedAt, now));
    return {
      id: enrollment.userId,
      name: enrollment.user.name,
      phone: enrollment.user.phone,
      age: enrollment.user.age,
      attendance_pct: pct,
      tier: tierOf(pct),
      last_seen: lastSeenMap.get(enrollment.userId)?.toISOString().slice(0, 10) ?? null,
    };
  });
}

export async function getStudentById(userId: string, academyId: string) {
  const [user, enrollments, attendance, trials] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, age: true, location: true },
    }),
    prisma.enrollment.findMany({
      where: { userId, batch: { academyId } },
      include: {
        batch: { select: { id: true, title: true, category: true, monthlyFeePaise: true, sessionsPerMonth: true } },
        // S4.1: current active/grace period → renewal date.
        periods: { where: { status: { in: ['active', 'grace'] } }, orderBy: { endDate: 'desc' }, take: 1, select: { endDate: true } },
      },
    }),
    prisma.batchAttendance.findMany({
      where: { userId, batch: { academyId } },
      orderBy: { date: 'desc' },
      take: 30,
      include: { batch: { select: { title: true } } },
    }),
    prisma.trial.findMany({
      where: { userId, academyId },
      orderBy: { trialAt: 'desc' },
      take: 10,
      include: { batch: { select: { title: true } } },
    }),
  ]);
  return { user, enrollments, attendance, trials };
}

export async function getReviews(
  academyId: string,
  filter?: 'all' | 'needs_reply' | 'replied' | '5' | 'lte3',
  limit = 50,
) {
  const where: Record<string, unknown> = { academyId };
  if (filter === 'needs_reply') where.response = null;
  else if (filter === 'replied') where.response = { not: null };
  else if (filter === '5') where.rating = 5;
  else if (filter === 'lte3') where.rating = { lte: 3 };

  return prisma.review.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { user: { select: { name: true } }, batch: { select: { title: true } } },
  });
}

export async function getReviewsSummary(academyId: string) {
  const [grouped, needsReply] = await Promise.all([
    prisma.review.groupBy({
      by: ['rating'],
      where: { academyId },
      _count: { rating: true },
    }),
    prisma.review.count({ where: { academyId, response: null } }),
  ]);
  const breakdown: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let weighted = 0;
  for (const g of grouped) {
    const r = g.rating as 1 | 2 | 3 | 4 | 5;
    const c = g._count.rating;
    if (r >= 1 && r <= 5) breakdown[r] = c;
    total += c;
    weighted += r * c;
  }
  return {
    average: total ? Math.round((weighted / total) * 10) / 10 : 0,
    count: total,
    breakdown,
    needs_reply: needsReply,
  };
}

export async function getAttendanceCountsFor(
  pairs: { userId: string; batchId: string }[],
) {
  const result = new Map<string, number>();
  if (pairs.length === 0) return result;
  const userIds = [...new Set(pairs.map((p) => p.userId))];
  const batchIds = [...new Set(pairs.map((p) => p.batchId))];
  const grouped = await prisma.batchAttendance.groupBy({
    by: ['userId', 'batchId'],
    where: { userId: { in: userIds }, batchId: { in: batchIds }, present: true },
    _count: { present: true },
  });
  for (const g of grouped) {
    result.set(`${g.userId}:${g.batchId}`, g._count.present);
  }
  return result;
}

export async function respondToReview(id: string, academyId: string, response: string) {
  return prisma.review.updateMany({
    where: { id, academyId },
    data: { response, respondedAt: new Date() },
  });
}

type EarningsPeriod = 'week' | 'month' | 'year';

function periodWindow(period: EarningsPeriod, now: Date) {
  if (period === 'week') {
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    return { start, end: now, prevStart, prevEnd: start };
  }
  if (period === 'year') {
    const start = new Date(now.getFullYear(), 0, 1);
    const prevStart = new Date(now.getFullYear() - 1, 0, 1);
    return { start, end: now, prevStart, prevEnd: start };
  }
  // month
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { start, end: now, prevStart, prevEnd: start };
}

export type EarningsCategory = 'trial' | 'enrollment' | 'workshop';
export type EarningsOpts = {
  period?: EarningsPeriod;
  /** Explicit window (overrides period). prev-window = same length immediately before. */
  from?: Date;
  to?: Date;
  /** Scope every figure to one revenue source. */
  category?: EarningsCategory;
};

export async function getEarnings(academyId: string, opts: EarningsOpts = {}) {
  const now = new Date();
  const period = opts.period ?? 'month';
  const category = opts.category;
  let start: Date, end: Date, prevStart: Date, prevEnd: Date;
  if (opts.from && opts.to) {
    start = opts.from;
    end = opts.to;
    const len = Math.max(1, end.getTime() - start.getTime());
    prevEnd = start;
    prevStart = new Date(start.getTime() - len);
  } else {
    ({ start, end, prevStart, prevEnd } = periodWindow(period, now));
  }
  // Which revenue sources are in scope (all, unless a category filter is set).
  const inc = {
    trial: !category || category === 'trial',
    enrollment: !category || category === 'enrollment',
    workshop: !category || category === 'workshop',
  };

  const [trialPayments, enrollmentPayments, workshopPayments, prevAll, payoutRows, academy, commissionRows] =
    await Promise.all([
      prisma.payment.findMany({
        where: { status: 'captured', capturedAt: { gte: start, lte: end }, booking: { batch: { academyId } } },
        include: {
          booking: { include: { batch: { select: { id: true, title: true } }, user: { select: { name: true } } } },
        },
        orderBy: { capturedAt: 'desc' },
      }),
      prisma.enrollmentPayment.findMany({
        where: {
          status: 'captured',
          capturedAt: { gte: start, lte: end },
          enrollmentPeriod: { enrollment: { batch: { academyId } } },
        },
        include: {
          enrollmentPeriod: {
            include: {
              enrollment: { include: { batch: { select: { id: true, title: true } }, user: { select: { name: true } } } },
            },
          },
        },
        orderBy: { capturedAt: 'desc' },
      }),
      prisma.workshopPayment.findMany({
        where: {
          status: 'captured',
          capturedAt: { gte: start, lte: end },
          registration: { workshop: { academyId } },
        },
        include: {
          registration: { include: { workshop: { select: { title: true } }, user: { select: { name: true } } } },
        },
        orderBy: { capturedAt: 'desc' },
      }),
      // previous-period totals for delta (all three sources)
      Promise.all([
        prisma.payment.aggregate({
          _sum: { amountPaise: true },
          where: { status: 'captured', capturedAt: { gte: prevStart, lte: prevEnd }, booking: { batch: { academyId } } },
        }),
        prisma.enrollmentPayment.aggregate({
          _sum: { amountPaise: true },
          where: { status: 'captured', capturedAt: { gte: prevStart, lte: prevEnd }, enrollmentPeriod: { enrollment: { batch: { academyId } } } },
        }),
        prisma.workshopPayment.aggregate({
          _sum: { amountPaise: true },
          where: { status: 'captured', capturedAt: { gte: prevStart, lte: prevEnd }, registration: { workshop: { academyId } } },
        }),
      ]),
      prisma.payout.findMany({ where: { academyId }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.academy.findUnique({ where: { id: academyId }, select: { bankAccountNumber: true, bankHolderName: true } }),
      // S4.6: commission accrued for this academy in the window (events carry none — platform-owned).
      prisma.commissionLedger.findMany({
        where: { academyId, status: 'accrued', createdAt: { gte: start, lte: end } },
        select: { itemType: true, itemId: true, commissionPaise: true, reversedPaise: true },
      }),
    ]);

  // S4.6: live commission per item = commissionPaise − reversedPaise. Keyed by itemId
  // (trial→bookingId, enrolment→enrollmentPeriodId, workshop→workshopPaymentId).
  const commByItem = new Map<string, number>();
  const commByType: Record<string, number> = { trial: 0, enrollment: 0, workshop: 0 };
  for (const c of commissionRows) {
    const net = c.commissionPaise - c.reversedPaise;
    commByItem.set(c.itemId, (commByItem.get(c.itemId) ?? 0) + net);
    commByType[c.itemType] = (commByType[c.itemType] ?? 0) + net;
  }

  // Category filter: drop out-of-scope sources before any aggregation.
  const trialP = inc.trial ? trialPayments : [];
  const enrollP = inc.enrollment ? enrollmentPayments : [];
  const workP = inc.workshop ? workshopPayments : [];

  const sum = (arr: { amountPaise: number }[]) => arr.reduce((s, p) => s + p.amountPaise, 0);
  const trialTotal = sum(trialP);
  const monthlyTotal = sum(enrollP);
  const workshopTotal = sum(workP);
  const grossPaise = trialTotal + monthlyTotal + workshopTotal;
  const commissionTotal =
    (inc.trial ? commByType.trial : 0) + (inc.enrollment ? commByType.enrollment : 0) + (inc.workshop ? commByType.workshop : 0);
  const netPaise = grossPaise - commissionTotal;
  const totalPaise = grossPaise; // back-compat alias

  const prevTotal =
    (inc.trial ? prevAll[0]._sum.amountPaise ?? 0 : 0) +
    (inc.enrollment ? prevAll[1]._sum.amountPaise ?? 0 : 0) +
    (inc.workshop ? prevAll[2]._sum.amountPaise ?? 0 : 0);

  // by_batch (trial + monthly contribute to batch revenue) — net of commission
  const byBatch: Record<string, { batch_id: string; batch_title: string; gross_paise: number; commission_paise: number; net_paise: number; count: number }> = {};
  const addBatch = (id: string, title: string, amt: number, comm: number) => {
    if (!byBatch[id]) byBatch[id] = { batch_id: id, batch_title: title, gross_paise: 0, commission_paise: 0, net_paise: 0, count: 0 };
    byBatch[id].gross_paise += amt;
    byBatch[id].commission_paise += comm;
    byBatch[id].net_paise += amt - comm;
    byBatch[id].count++;
  };
  for (const p of trialP) addBatch(p.booking.batch.id, p.booking.batch.title, p.amountPaise, commByItem.get(p.bookingId) ?? 0);
  for (const p of enrollP) {
    const b = p.enrollmentPeriod.enrollment.batch;
    addBatch(b.id, b.title, p.amountPaise, commByItem.get(p.enrollmentPeriodId) ?? 0);
  }

  // transactions feed (captured = in; refunds = out)
  type Txn = { id: string; label: string; kind: string; dir: 'in' | 'out'; amount_paise: number; commission_paise: number; net_paise: number; at: string };
  const transactions: Txn[] = [];
  const txn = (id: string, label: string, kind: string, amt: number, comm: number, at: string): Txn =>
    ({ id, label, kind, dir: 'in', amount_paise: amt, commission_paise: comm, net_paise: amt - comm, at });
  for (const p of trialP) {
    transactions.push(txn(p.id, `${p.booking.user.name} · Trial`, 'trial', p.amountPaise, commByItem.get(p.bookingId) ?? 0, (p.capturedAt ?? p.createdAt).toISOString()));
    if (p.refundAmountPaise) transactions.push({ id: `${p.id}_r`, label: `Refund · ${p.booking.user.name}`, kind: 'refund', dir: 'out', amount_paise: p.refundAmountPaise, commission_paise: 0, net_paise: p.refundAmountPaise, at: (p.refundedAt ?? p.createdAt).toISOString() });
  }
  for (const p of enrollP) {
    const e = p.enrollmentPeriod.enrollment;
    transactions.push(txn(p.id, `${e.user.name} · ${e.batch.title}`, 'monthly', p.amountPaise, commByItem.get(p.enrollmentPeriodId) ?? 0, (p.capturedAt ?? p.createdAt).toISOString()));
  }
  for (const p of workP) {
    transactions.push(txn(p.id, `${p.registration.user.name} · ${p.registration.workshop.title}`, 'workshop', p.amountPaise, commByItem.get(p.id) ?? 0, (p.capturedAt ?? p.createdAt).toISOString()));
  }
  transactions.sort((a, b) => (a.at < b.at ? 1 : -1));

  const bankLast4 = academy?.bankAccountNumber ? academy.bankAccountNumber.slice(-4) : undefined;

  return {
    period,
    total_paise: totalPaise, // back-compat = gross
    gross_paise: grossPaise,
    commission_paise: commissionTotal,
    net_paise: netPaise,
    delta_paise: grossPaise - prevTotal,
    by_category: [
      { category: 'trial', captured_paise: trialTotal, commission_paise: inc.trial ? commByType.trial : 0, net_paise: trialTotal - (inc.trial ? commByType.trial : 0), count: trialP.length },
      { category: 'monthly', captured_paise: monthlyTotal, commission_paise: inc.enrollment ? commByType.enrollment : 0, net_paise: monthlyTotal - (inc.enrollment ? commByType.enrollment : 0), count: enrollP.length },
      { category: 'workshop', captured_paise: workshopTotal, commission_paise: inc.workshop ? commByType.workshop : 0, net_paise: workshopTotal - (inc.workshop ? commByType.workshop : 0), count: workP.length },
    ].filter((c) => c.count > 0),
    by_batch: Object.values(byBatch),
    transactions: transactions.slice(0, 30),
    payouts: payoutRows.map((payout) => ({
      id: payout.id,
      amount_paise: payout.amountPaise,
      status: payout.status,
      paid_at: payout.paidAt?.toISOString(),
      bank_last4: bankLast4,
      bank_name: academy?.bankHolderName ?? undefined,
    })),
  };
}

export async function getSettings(accountId: string) {
  return prisma.academySettings.findUnique({ where: { accountId } });
}

export async function upsertSettings(accountId: string, data: Record<string, unknown>) {
  return prisma.academySettings.upsert({
    where: { accountId },
    create: { accountId, ...(data as any) },
    update: data,
  });
}

export async function getAcademyById(id: string) {
  return prisma.academy.findUnique({ where: { id } });
}

export async function updateAcademy(id: string, data: Record<string, unknown>) {
  return prisma.academy.update({ where: { id }, data });
}
