import type { BatchGender, BatchMode, Category, OfferedMode, SessionFormat } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { istDateKey, istWallClockToUtc } from '../../lib/ist.js';
import { toWireMode } from '../../lib/mode.js';
import { type AttendanceTier } from '../../lib/attendance-tier.js';
import { statsForBatch, statsForBatches, type StudentStat } from '../attendance/stats.js';
import { batchScopeById, type BatchScope } from '../../lib/scope.js';
import { LEARNER_CARD_SELECT, studentCard } from '../../lib/learner-access.js';

export async function getDashboardStats(scope: BatchScope) {
  const academyId = scope.academyId;
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
    prisma.trial.count({ where: { batch: scope, status: 'booked' } }),
    prisma.trial.count({ where: { batch: scope, status: 'booked', trialAt: { gte: now } } }),
    prisma.trial.count({ where: { batch: scope, status: 'attended' } }),
    prisma.trial.count({
      where: {
        batch: scope,
        status: { in: ['booked', 'attended'] },
        trialAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.enrollment.count({ where: { batch: scope } }),
    grossFor(startOfMonth),
    grossFor(startOfLastMonth, endOfLastMonth),
    prisma.review.findMany({
      where: { academyId, batch: scope },
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
    recent_reviews: recentReviews.map((r) => ({
      id: r.id,
      student_name: r.user.name,
      rating: r.rating,
      comment: r.comment,
      response: r.response,
      created_at: r.createdAt.toISOString(),
    })),
  };
}

// GROUP-scoped, deliberately ignoring `X-Branch-Id` (plan §5). Missing an operational item
// costs nothing — you see it when you switch branch. An unseen trial request on a branch you
// are not currently on is a lost sale, so enquiries are the documented exception to the
// branch-scoping rule. Every row carries its branch so the list stays legible.
export async function getInboxItems(
  groupId: string,
  status?: string,
  limit = 20,
  allowedIds?: string[],
  scope?: BatchScope,
) {
  // The group-wide default above is right for an OWNER. For a branch-scoped subject it would
  // leak another branch's enquiries — student names and phone numbers — so the scope narrows
  // to the branches they hold (§5.3).
  // Three widths, narrowest wins: a teacher's own batches, else a manager's branches, else the
  // owner's whole brand.
  const branchScope = scope
    ? { batch: scope }
    : allowedIds
      ? { academyId: { in: allowedIds } }
      : { academy: { groupId } };
  const where: Record<string, unknown> = { ...branchScope };
  if (status && status !== 'all') {
    if (status === 'new') where.status = 'booked';
    else if (status === 'pending') where.status = 'booked';
    else if (status === 'confirmed') where.status = 'attended';
    else where.status = status;
  }

  const items = await prisma.trial.findMany({
    where: where as never,
    orderBy: { trialAt: 'asc' },
    take: limit,
    include: {
      user: { select: { name: true, phone: true, age: true } },
      learner: LEARNER_CARD_SELECT,
      academy: { select: { id: true, name: true, branchLabel: true } },
      batch: {
        select: {
          title: true,
          name: true,
          category: true,
          trialFeePaise: true,
          coach: { select: { name: true } },
          // `level` moved to Program; the inbox still shows it alongside the batch.
          program: { select: { level: true } },
        },
      },
    },
  });

  const counts = {
    new: await prisma.trial.count({ where: { ...branchScope, status: 'booked' } }),
    pending: await prisma.trial.count({ where: { ...branchScope, status: 'booked', trialAt: { gte: new Date() } } }),
    confirmed: await prisma.trial.count({ where: { ...branchScope, status: 'attended' } }),
  };

  return { items, counts };
}

export async function getTrialDetail(id: string, scope: BatchScope) {
  return prisma.trial.findFirst({
    // Trial carries `batchId`, so `batch: scope` narrows a teacher to trials on their own
    // classes — the ones whose attendance code they will actually be asked to verify.
    where: { id, academyId: scope.academyId, batch: scope },
    include: {
      user: { select: { id: true, name: true, phone: true, age: true, location: true } },
      learner: LEARNER_CARD_SELECT,
      batch: {
        select: {
          title: true,
          category: true,
          name: true,
          mode: true,
          trialFeePaise: true,
          program: { select: { level: true } },
          // Who is actually taking this trial. The inbox LIST has always joined this
          // (`getInboxItems`); the detail query did not, so the screen that shows one trial —
          // the screen you stand on to greet the student — rendered the coach as "—" every time.
          coach: { select: { name: true } },
        },
      },
      booking: { select: { status: true, createdAt: true, payment: { select: { status: true } } } },
    },
  });
}

export async function getActivity(scope: BatchScope, limit = 12) {
  const academyId = scope.academyId;
  const [attendedTrials, reviews, enrollments, workshopRegs] = await Promise.all([
    prisma.trial.findMany({
      where: { batch: scope, status: 'attended' },
      orderBy: { attendanceMarkedAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } }, learner: { select: { name: true } }, batch: { select: { title: true } } },
    }),
    prisma.review.findMany({
      where: { academyId, batch: scope },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } } },
    }),
    prisma.enrollment.findMany({
      where: { batch: scope, status: 'active' },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } }, learner: { select: { name: true } }, batch: { select: { title: true } } },
    }),
    // Workshops carry no batch, so this stays branch-grained for every role — the same reason
    // `workshops.view` is a branch-scope permission (see lib/permissions.ts).
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
// D1), with ClassSession overlaid as the `cancelled` status. Still a projection, deliberately:
// the schedule looks FORWARD, and a future session has no ClassSession row until its QR is issued
// or it is cancelled. Attendance reads (which look backward) go off ClassSession only. No slot_id.
export async function getSchedule(scope: BatchScope, weekStart: Date) {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const [batches, cancelled] = await Promise.all([
    prisma.batch.findMany({
      where: { ...scope, status: 'active' },
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
    prisma.classSession.findMany({
      where: {
        // Nested under `batch` so a teacher's cancelled-session markers match the same batches
        // their schedule shows — otherwise the grid would carry cancellations for classes they
        // cannot see.
        batch: scope,
        status: 'cancelled',
        sessionDate: { gte: weekStart, lt: weekEnd },
      },
      select: { batchId: true, sessionDate: true },
    }),
  ]);

  const cancelledSet = new Set(cancelled.map((c) => `${c.batchId}:${istDateKey(c.sessionDate)}`));
  const now = new Date();
  const days: Record<string, any[]> = {};

  for (let d = 0; d < 7; d++) {
    const dateStr = istDateKey(new Date(weekStart.getTime() + d * 86400000));
    const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    for (const b of batches) {
      for (const t of b.timings) {
        if (t.dayOfWeek !== dow) continue;
        const [hh, mm] = t.startTime.split(':').map(Number);
        const start = istWallClockToUtc(dateStr, hh, mm);
        const end = new Date(start.getTime() + t.durationMin * 60_000);
        let status: string;
        if (cancelledSet.has(`${b.id}:${dateStr}`)) status = 'cancelled';
        else if (now >= start && now <= end) status = 'now';
        else if (now < start) status = 'upcoming';
        else status = 'done';

        if (!days[dateStr]) days[dateStr] = [];
        days[dateStr].push({
          batch_id: b.id,
          session_date: dateStr,
          batch_title: b.title,
          category: b.category,
          capacity: b.capacity,
          enrolled_count: b._count.enrollments,
          coach_name: b.coach?.name ?? null,
          mode: toWireMode(b.mode),
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          status,
        });
      }
    }
  }

  return Object.entries(days)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, items: items.sort((x, y) => x.start_time.localeCompare(y.start_time)) }));
}

// S1.3: include active-enrollment count so the serializer can derive trialSpots = capacity − enrolled.
const ACTIVE_ENROLLMENT_COUNT = { _count: { select: { enrollments: { where: { status: 'active' as const } } } } };

export async function getBatches(scope: BatchScope) {
  return prisma.batch.findMany({
    where: scope,
    include: {
      coach: { select: { name: true } },
      timings: true,
      // `level` moved to Program; batch views still display it.
      program: { select: { level: true } },
      ...ACTIVE_ENROLLMENT_COUNT,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getBatchById(id: string, scope: BatchScope) {
  return prisma.batch.findFirst({
    // A teacher asking for another coach's batch id gets null, which the service turns into a
    // 404 — the same answer as a batch from another brand.
    where: batchScopeById(scope, id),
    include: {
      coach: { select: { name: true } },
      timings: true,
      program: { select: { level: true } },
      ...ACTIVE_ENROLLMENT_COUNT,
    },
  });
}

export async function createBatch(data: {
  academyId: string;
  programId: string;
  coachId: string;
  title: string;
  category: string;
  name: string;
  minAge?: number | null;
  maxAge?: number | null;
  sessionFormat?: string;
  gender?: string;
  description?: string;
  thingsToKnow?: string[];
  capacity: number;
  trialFeePaise: number;
  monthlyFeePaise: number;
  quarterlyDiscountBps?: number;
  annualDiscountBps?: number;
  mode?: string;
}) {
  // `category`/`mode`/`sessionFormat`/`gender` are validated/mapped upstream; the casts align
  // with Prisma's generated enum inputs (FKs are unchecked scalars). programId is required —
  // every batch is created under a program (the service resolves + validates it).
  const { mode, sessionFormat, gender, ...rest } = data;
  return prisma.batch.create({
    data: {
      ...rest,
      category: data.category as Category,
      ...(mode ? { mode: mode as BatchMode } : {}),
      ...(sessionFormat ? { sessionFormat: sessionFormat as SessionFormat } : {}),
      ...(gender ? { gender: gender as BatchGender } : {}),
    },
  });
}

// --- Programs (BRAND-authored offerings that own batches) ---
//
// Programs are group-scoped: "Guitar Lessons" is authored once and offered wherever the brand
// runs a batch of it. The studio list is therefore group-wide, and each program reports how
// many batches it has AT the active branch so the owner can see what this location runs.

// `Program` is brand-level by design, so there is no `academyId` to filter on. A branch-scoped
// subject instead sees programs that are actually OFFERED at a branch they hold — availability
// is derived from where batches run, never stored.
//
// The `none` half matters: a program with no batches anywhere is not yet offered at ANY branch,
// and hiding it would trap a manager who holds `batches.manage` into being unable to see the
// program they need to create that first batch under.
export function programScope(allowedIds?: string[]) {
  if (!allowedIds) return {};
  return {
    OR: [
      { batches: { some: { academyId: { in: allowedIds } } } },
      { batches: { none: {} } },
    ],
  };
}

// BRAND settings: the public contact details and privacy flag. Keyed on the GROUP, because
// these are read by student-facing code — stored per-login, the contact number a learner sees
// would depend on which staff member saved last.
export async function getGroupSettings(groupId: string) {
  return prisma.academyGroupSettings.findUnique({ where: { groupId } });
}

export async function upsertGroupSettings(groupId: string, data: Record<string, unknown>) {
  return prisma.academyGroupSettings.upsert({
    where: { groupId },
    create: { groupId, ...data },
    update: data,
  });
}

export async function getPrograms(groupId: string, academyId?: string, allowedIds?: string[]) {
  return prisma.program.findMany({
    where: { groupId, ...programScope(allowedIds) },
    include: {
      _count: {
        select: {
          batches: academyId ? { where: { academyId } } : true,
        },
      },
      media: { orderBy: { order: 'asc' }, take: 1 }, // cover only for the list
    },
    orderBy: { createdAt: 'desc' },
  });
}

// Program detail. Batches are branch-scoped when `academyId` is given — the studio is looking
// at one location — while the program copy itself stays brand-level.
export async function getProgramById(id: string, groupId: string, academyId?: string) {
  return prisma.program.findFirst({
    where: { id, groupId },
    include: {
      media: { orderBy: { order: 'asc' } },
      batches: {
        where: academyId ? { academyId } : undefined,
        include: {
          coach: { select: { name: true } },
          timings: true,
          academy: { select: { id: true, name: true, branchLabel: true } },
          ...ACTIVE_ENROLLMENT_COUNT,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
}

type MediaInput = { url: string; type: string }[];

export async function createProgram(data: {
  groupId: string;
  title: string;
  category: string;
  level: string;
  description?: string;
  thingsToKnow?: string[];
  media?: MediaInput;
}) {
  return prisma.program.create({
    data: {
      groupId: data.groupId,
      title: data.title,
      category: data.category as Category,
      level: data.level,
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
  groupId: string,
  data: Record<string, unknown>,
  media?: MediaInput,
) {
  // Ownership check (updateMany can't be scoped through a relation replace).
  const owned = await prisma.program.findFirst({ where: { id, groupId }, select: { id: true } });
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

export async function deleteProgram(id: string, groupId: string) {
  return prisma.program.deleteMany({ where: { id, groupId } });
}

// Invariant §3.1: a batch's program must belong to the same brand as its branch. A batch
// pointing at another brand's program is silent, permanent corruption, so this is checked on
// every batch create/update.
export async function programBelongsToGroup(programId: string, groupId: string) {
  return prisma.program.findFirst({ where: { id: programId, groupId }, select: { id: true } });
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
  // NOT scoped by coach: `batches.delete` is owner-only, so `assigned` never reaches here.
  const batch = await prisma.batch.findFirst({ where: { id, academyId } });
  if (!batch) return;
  await prisma.$transaction([
    prisma.review.deleteMany({ where: { batchId: id } }),
    prisma.trial.deleteMany({ where: { batchId: id } }),
    prisma.payment.deleteMany({ where: { booking: { batchId: id } } }),
    prisma.booking.deleteMany({ where: { batchId: id } }),
    // Credits reference both the enrolment and the session, so they go before either.
    prisma.sessionCredit.deleteMany({ where: { batchId: id } }),
    prisma.enrollment.deleteMany({ where: { batchId: id } }),
    prisma.batchAttendance.deleteMany({ where: { batchId: id } }),
    prisma.classSession.deleteMany({ where: { batchId: id } }),
    prisma.slot.deleteMany({ where: { batchId: id } }),
    prisma.batchTiming.deleteMany({ where: { batchId: id } }),
    prisma.batch.deleteMany({ where: { id, academyId } }),
  ]);
}

export async function getStudents(
  scope: BatchScope,
  q?: string,
  limit = 20,
  batchId?: string,
  attendanceTier?: AttendanceTier,
) {
  // ⚠️ The `batch_id` query param must NARROW the scope, never widen it. `batchScopeById`
  // keeps `coachId` intact alongside the id, so passing another coach's batch id yields no
  // rows rather than that batch's roster.
  const batchWhere: any = batchId ? batchScopeById(scope, batchId) : { ...scope };

  const where: any = { batch: batchWhere, status: 'active' };
  // Search the learner's name and the guardian's, so a parent calling about a child is findable either way.
  if (q) {
    where.OR = [
      { learner: { name: { contains: q, mode: 'insensitive' } } },
      { user: { name: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const enrollments = await prisma.enrollment.findMany({
    where,
    include: {
      user: { select: { id: true, name: true, phone: true, age: true } },
      learner: LEARNER_CARD_SELECT,
      batch: { select: { id: true, title: true, category: true, sessionsPerMonth: true } },
    },
  });

  // % from the real record: finalised held sessions the student was expected at, present rows
  // against them. Computed over every session of the batch (no month filter) — this list is a
  // "who needs attention" view, and the month-scoped view is the Attendance tab.
  const stats = await statsForBatches([...new Set(enrollments.map((e) => e.batchId))]);
  const statFor = (learnerId: string, batchId: string): StudentStat | undefined =>
    stats.get(batchId)?.per_student.find((s) => s.learner_id === learnerId);

  const withTier = enrollments.map((e) => {
    const stat = statFor(e.learnerId, e.batchId);
    return { ...e, attendance_pct: stat?.pct ?? null, tier: stat?.tier ?? null };
  });

  const filtered = attendanceTier ? withTier.filter((e) => e.tier === attendanceTier) : withTier;
  return filtered.slice(0, limit);
}

export async function getBatchStudents(batchId: string, scope: BatchScope) {
  const enrollments = await prisma.enrollment.findMany({
    where: { batchId, batch: batchScopeById(scope, batchId), status: 'active' },
    include: {
      user: { select: { id: true, name: true, phone: true, age: true } },
      learner: LEARNER_CARD_SELECT,
    },
  });

  const learnerIds = enrollments.map((e) => e.learnerId);
  const stats = await statsForBatch(batchId);

  const lastSeen = await prisma.batchAttendance.findMany({
    where: { batchId, learnerId: { in: learnerIds }, present: true },
    orderBy: { date: 'desc' },
    distinct: ['learnerId'],
    select: { learnerId: true, date: true },
  });
  const lastSeenMap = new Map(lastSeen.map((r) => [r.learnerId, r.date]));

  return enrollments.map((e) => {
    const stat = stats.per_student.find((s) => s.learner_id === e.learnerId);
    const card = studentCard(e.user, e.learner);
    return {
      // A learner id. Endpoints that take a student id accept it, and still accept the user ids
      // older academy-app builds hold.
      id: e.learnerId,
      user_id: e.userId,
      learner_id: e.learnerId,
      name: card.name,
      phone: card.phone,
      age: card.age,
      guardian_name: card.guardian_name,
      attendance_pct: stat?.pct ?? null,
      tier: stat?.tier ?? null,
      present: stat?.present ?? 0,
      expected: stat?.expected ?? 0,
      last_seen: lastSeenMap.get(e.learnerId)?.toISOString().slice(0, 10) ?? null,
    };
  });
}

// `learnerId` names the student. The guardian account comes back as `user` for contact details.
export async function getStudentById(learnerId: string, scope: BatchScope) {
  const [learner, guardianship, enrollments, attendance, trials] = await Promise.all([
    prisma.learner.findUnique({ where: { id: learnerId }, ...LEARNER_CARD_SELECT }),
    prisma.guardianship.findFirst({
      where: { learnerId },
      orderBy: { createdAt: 'asc' },
      select: { user: { select: { id: true, name: true, phone: true, age: true, location: true } } },
    }),
    prisma.enrollment.findMany({
      where: { learnerId, batch: scope },
      include: {
        batch: { select: { id: true, title: true, category: true, monthlyFeePaise: true, sessionsPerMonth: true } },
        // S4.1: current active/grace period → renewal date.
        periods: { where: { status: { in: ['active', 'grace'] } }, orderBy: { endDate: 'desc' }, take: 1, select: { endDate: true } },
      },
    }),
    prisma.batchAttendance.findMany({
      where: { learnerId, batch: scope },
      orderBy: { date: 'desc' },
      take: 30,
      include: { batch: { select: { title: true } } },
    }),
    // Trials hang off the BRANCH, not a batch, so they carry no coachId to filter on. A
    // teacher sees the trials for their own batches only — `batch: scope` rather than
    // `academyId`, which is also why the academyId filter is dropped: it is inside `scope`.
    prisma.trial.findMany({
      where: { learnerId, batch: scope },
      orderBy: { trialAt: 'desc' },
      take: 10,
      include: { batch: { select: { title: true } } },
    }),
  ]);
  return { learner, user: guardianship?.user ?? null, enrollments, attendance, trials };
}

export async function getReviews(
  scope: BatchScope,
  filter?: 'all' | 'needs_reply' | 'replied' | '5' | 'lte3',
  limit = 50,
) {
  // Review carries `batchId`, so a teacher sees the reviews left on their own classes — which
  // is the half of this screen that is actually about them.
  const where: Record<string, unknown> = { academyId: scope.academyId, batch: scope };
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

export async function getReviewsSummary(scope: BatchScope) {
  // Scoped alongside getReviews, or the star breakdown would describe a different set of
  // reviews than the list under it.
  const where = { academyId: scope.academyId, batch: scope };
  const [grouped, needsReply] = await Promise.all([
    prisma.review.groupBy({
      by: ['rating'],
      where,
      _count: { rating: true },
    }),
    prisma.review.count({ where: { ...where, response: null } }),
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

/**
 * What each branch of the brand earned in one window.
 *
 * Read off `commission_ledger` rather than re-running the three payment queries per branch:
 * the ledger already carries `academyId` (the branch a payment came from) alongside the gross
 * and the commission, which is exactly the product rule — one payout account, but money stays
 * tagged to where it was made.
 *
 * `reversedPaise` is a proportional reversal on refund, so it comes off BOTH sides: the
 * academy neither keeps the gross nor is charged commission on money it gave back.
 */
export async function getBranchEarnings(groupId: string, start: Date, end: Date) {
  const rows = await prisma.commissionLedger.groupBy({
    by: ['academyId'],
    where: { academy: { groupId }, createdAt: { gte: start, lte: end } },
    _sum: { grossPaise: true, commissionPaise: true, reversedPaise: true },
  });

  // Every branch appears, including ones that earned nothing this window — a zero is a fact
  // the owner wants to see, not a row to hide.
  const branches = await prisma.academy.findMany({
    where: { groupId },
    select: { id: true, name: true, branchLabel: true },
    orderBy: { createdAt: 'asc' },
  });

  const byId = new Map(rows.map((r) => [r.academyId, r._sum]));
  return branches.map((b) => {
    const sums = byId.get(b.id);
    const gross = sums?.grossPaise ?? 0;
    const commission = sums?.commissionPaise ?? 0;
    const reversed = sums?.reversedPaise ?? 0;
    return {
      academy_id: b.id,
      label: b.branchLabel ?? b.name,
      gross_paise: Math.max(0, gross - reversed),
      commission_paise: Math.max(0, commission - reversed),
      net_paise: Math.max(0, gross - reversed - Math.max(0, commission - reversed)),
    };
  });
}

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
      // Payouts and bank details are PAYEE-grain, not branch-grain: two branches sharing a
      // financial entity settle in one payout row and to one bank account, so both are read
      // through the branch's entity. The revenue figures above stay branch-scoped — the
      // earnings screen still answers "how did THIS location do".
      prisma.payout.findMany({
        where: { financialEntity: { branches: { some: { id: academyId } } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.academy.findUnique({
        where: { id: academyId },
        select: {
          financialEntity: { select: { id: true, bankAccountNumber: true, bankHolderName: true } },
        },
      }),
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

  const entity = academy?.financialEntity ?? null;
  const bankLast4 = entity?.bankAccountNumber ? entity.bankAccountNumber.slice(-4) : undefined;

  return {
    period,
    total_paise: totalPaise, // back-compat = gross
    // The resolved window, so callers (the branch breakdown) can cover exactly the same
    // period as this total rather than re-deriving it and drifting.
    window_start: start.toISOString(),
    window_end: end.toISOString(),
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
    payouts: payoutRows.map((p) => ({
      id: p.id,
      amount_paise: p.amountPaise,
      status: p.status,
      paid_at: p.paidAt?.toISOString(),
      bank_last4: bankLast4,
      bank_name: entity?.bankHolderName ?? undefined,
    })),
  };
}

// PER-LOGIN settings: notification preferences and quiet hours. Correctly keyed on accountId —
// a manager and a teacher genuinely want different alerts.
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
  return prisma.academy.findUnique({
    where: { id },
    include: {
      group: { select: { id: true, name: true } },
      financialEntity: {
        include: {
          gstRegistrations: { orderBy: { createdAt: 'asc' } },
          // How many branches an edit to this payee would affect.
          _count: { select: { branches: true } },
        },
      },
    },
  });
}

export async function updateAcademy(id: string, data: Record<string, unknown>) {
  return prisma.academy.update({ where: { id }, data });
}

// The brand a branch belongs to. Batch writes validate their program and coach against THIS
// — the branch's actual group — rather than against the caller's token, so invariants §3.1
// and §3.2 hold even if the two ever disagreed.
export async function groupIdForBranch(academyId: string): Promise<string | null> {
  const branch = await prisma.academy.findUnique({
    where: { id: academyId },
    select: { groupId: true },
  });
  return branch?.groupId ?? null;
}

// --- Branches + financial entities (multi-branch) ---

// `allowedIds` narrows the list to a staff subject's branch scope. `undefined` means the whole
// group (an owner). NOTE this must never be an empty-array-means-everything filter: an empty
// scope has to return an empty list, which `{ in: [] }` correctly does.
export async function listBranches(groupId: string, allowedIds?: string[]) {
  return prisma.academy.findMany({
    where: { groupId, ...(allowedIds ? { id: { in: allowedIds } } : {}) },
    select: {
      id: true,
      name: true,
      branchLabel: true,
      // The client's onboarding-completeness check reads this. Without it the session's branch
      // payload was a lossy copy of the branch, and rehydrating the store from it looked like
      // an academy that had never been set up.
      category: true,
      address: true,
      lat: true,
      lng: true,
      status: true,
      verified: true,
      rating: true,
      ratingCount: true,
      images: true,
      financialEntityId: true,
      createdAt: true,
      _count: { select: { batches: { where: { status: 'active' } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getGroup(groupId: string) {
  return prisma.academyGroup.findUnique({ where: { id: groupId } });
}

/**
 * Rename the brand, and re-compose every one of its branches' display names with it.
 *
 * The second half is not a nicety. `Academy.name` is a COMPOSED value — `createBranch` writes
 * `` `${group.name} — ${branchLabel}` `` — and it is what text search reads
 * (`search/repo.ts` matches on `name`). Updating `AcademyGroup.name` alone would rename the
 * brand everywhere the studio app displays it while leaving every branch findable under the
 * OLD name in discovery, which is a half-applied rename users would report as a bug.
 *
 * The first branch created at signup carries `branchLabel: null` — its display name is just the
 * brand — so it takes the new name verbatim rather than gaining a stray em dash.
 *
 * One transaction: a partial rename is worse than none.
 */
export async function renameGroup(groupId: string, name: string) {
  return prisma.$transaction(async (tx) => {
    const group = await tx.academyGroup.update({ where: { id: groupId }, data: { name } });
    const branches = await tx.academy.findMany({
      where: { groupId },
      select: { id: true, branchLabel: true },
    });
    await Promise.all(
      branches.map((b) =>
        tx.academy.update({
          where: { id: b.id },
          data: { name: b.branchLabel ? `${name} — ${b.branchLabel}` : name },
        }),
      ),
    );
    return { group, branchCount: branches.length };
  });
}

export async function listFinancialEntities(groupId: string) {
  return prisma.financialEntity.findMany({
    where: { groupId },
    include: {
      gstRegistrations: { orderBy: { createdAt: 'asc' } },
      branches: { select: { id: true, name: true, branchLabel: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function findFinancialEntity(id: string, groupId: string) {
  return prisma.financialEntity.findFirst({ where: { id, groupId } });
}

// Create a branch, optionally with a brand-new payee. Invariant §3.3 — a branch's financial
// entity must belong to the branch's group — is enforced by the caller resolving the entity
// through `findFinancialEntity(id, groupId)` before this runs.
/**
 * The brand's ORIGINAL location — the one whose public profile a new branch starts from.
 *
 * Oldest-first, the same tie-break used elsewhere for a group's "primary" row (see
 * WORKSHOP_COACHES in workshops/repo.ts). Deliberately NOT the session's landing branch: which
 * branch an owner happens to be acting on should not decide what a new location inherits.
 */
export async function findGroupPrimaryBranch(groupId: string) {
  return prisma.academy.findFirst({
    where: { groupId },
    orderBy: { createdAt: 'asc' },
    select: { bio: true, tagline: true, specialities: true, modesOffered: true },
  });
}

export async function createBranch(data: {
  groupId: string;
  name: string;
  branchLabel: string;
  category: Category;
  address: string;
  lat?: number | null;
  lng?: number | null;
  images?: string[];
  financialEntityId?: string;
  newEntityLabel?: string;
  // The brand's public profile copy, carried over from the branch the owner already wrote.
  // See the comment on the create call below.
  bio?: string | null;
  tagline?: string | null;
  specialities?: string[];
  modesOffered?: OfferedMode[];
}) {
  return prisma.$transaction(async (tx) => {
    let financialEntityId = data.financialEntityId;
    if (!financialEntityId) {
      const entity = await tx.financialEntity.create({
        data: { groupId: data.groupId, label: data.newEntityLabel ?? data.branchLabel },
      });
      financialEntityId = entity.id;
    }
    return tx.academy.create({
      data: {
        groupId: data.groupId,
        financialEntityId,
        name: data.name,
        branchLabel: data.branchLabel,
        category: data.category,
        // Same reason as signup: discovery reads `categories`, never `category` alone.
        categories: [data.category as any],
        address: data.address,
        lat: data.lat ?? null,
        lng: data.lng ?? null,
        images: data.images ?? [],
        // Inherited from the brand's existing location. These four are what a learner reads on
        // the academy page, and the "add a branch" form asks for none of them — so a new
        // location used to publish with a blank profile next to a sibling that had one. They are
        // per-branch columns and stay editable per branch; this is the starting point, not a lock.
        bio: data.bio ?? null,
        tagline: data.tagline ?? null,
        specialities: data.specialities ?? [],
        modesOffered: data.modesOffered ?? [],
        // Every new location goes through branch review before it appears in discovery —
        // even when it reuses an already-KYC'd payee.
        status: 'pending_review',
        verified: false,
      },
    });
  });
}

// Replace the entity's GSTINs wholesale, and write the rest of the payee fields. Editing any
// of this affects every branch on the entity, which is why it is reachable only from group
// settings.
export async function updateFinancialEntity(
  id: string,
  data: Record<string, unknown>,
  gstRegistrations?: { gstNumber: string; state?: string }[],
) {
  return prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) {
      await tx.financialEntity.update({ where: { id }, data });
    }
    if (gstRegistrations) {
      await tx.gSTRegistration.deleteMany({ where: { financialEntityId: id } });
      if (gstRegistrations.length) {
        await tx.gSTRegistration.createMany({
          data: gstRegistrations.map((g) => ({
            financialEntityId: id,
            gstNumber: g.gstNumber,
            state: g.state ?? null,
          })),
        });
      }
    }
    return tx.financialEntity.findUnique({
      where: { id },
      include: { gstRegistrations: true, branches: { select: { id: true, name: true, branchLabel: true } } },
    });
  });
}

export async function setDefaultBranch(accountId: string, academyId: string) {
  return prisma.academyAccount.update({
    where: { id: accountId },
    data: { defaultAcademyId: academyId },
  });
}

/**
 * Every active enrolment with its CURRENT period, for the fees-due view.
 *
 * The period is the whole answer: `endDate` is the due date, `amountPaise` is how much, and
 * `status` (active / grace / expired) is where it stands. None of that reached the academy
 * before — `getStudents` includes `user` and `batch` and never touches `periods`, so the studio
 * could see attendance but not a single rupee owed, while `workers/renewal-reminder.ts` was
 * already pushing "3 days left" to the student.
 *
 * Latest period by `endDate` — a renewal writes a new row rather than moving the old one, so
 * ordering is what makes "current" correct. Covered by `@@index([enrollmentId, endDate])`.
 */
export async function getDues(scope: BatchScope) {
  return prisma.enrollment.findMany({
    where: { batch: scope, status: 'active' },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      learner: LEARNER_CARD_SELECT,
      batch: { select: { id: true, title: true, monthlyFeePaise: true } },
      periods: {
        orderBy: { endDate: 'desc' },
        take: 1,
        include: { payment: { select: { status: true } } },
      },
    },
  });
}
