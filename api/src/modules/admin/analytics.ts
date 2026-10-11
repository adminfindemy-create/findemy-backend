import type { Category } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { statsForBatches } from '../attendance/stats.js';

// Analytics is read-only: live Prisma aggregates over the four captured-payment tables plus the
// commission ledger. It mirrors the aggregation shapes in studio/repo.ts (getEarnings /
// getDashboardStats) but scopes them platform-wide (no academyId filter) or to one academy.
//
// Money is in paise. `captured` payments = realised GMV; commission net = accrued − reversed.

type Window = { from: Date; to: Date };

// Rolling window ending now. `days` counts back from today (default 30).
function rollingWindow(days: number): Window {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

const CAPTURED = 'captured' as const;

/** Present / expected across an academy's batches in a window, via the shared attendance engine. */
async function academyAttendanceTotals(academyId: string, window: Window) {
  const batches = await prisma.batch.findMany({ where: { academyId }, select: { id: true } });
  const stats = await statsForBatches(
    batches.map((b) => b.id),
    { from: window.from, to: window.to },
  );
  let present = 0;
  let expected = 0;
  for (const s of stats.values()) {
    for (const st of s.per_student) {
      present += st.present;
      expected += st.expected;
    }
  }
  return { present, expected };
}

// GMV across the four captured-payment tables for a window (optionally scoped to one academy).
// Events are platform-owned (no academyId) so an academy-scoped call omits them.
async function grossFor({ from, to }: Window, academyId?: string) {
  const capturedAt = { gte: from, lte: to };
  const [trial, enrol, workshop, event] = await Promise.all([
    prisma.payment.aggregate({
      _sum: { amountPaise: true },
      _count: true,
      where: { status: CAPTURED, capturedAt, ...(academyId ? { booking: { batch: { academyId } } } : {}) },
    }),
    prisma.enrollmentPayment.aggregate({
      _sum: { amountPaise: true },
      _count: true,
      where: {
        status: CAPTURED,
        capturedAt,
        ...(academyId ? { enrollmentPeriod: { enrollment: { batch: { academyId } } } } : {}),
      },
    }),
    prisma.workshopPayment.aggregate({
      _sum: { amountPaise: true },
      _count: true,
      where: { status: CAPTURED, capturedAt, ...(academyId ? { registration: { workshop: { academyId } } } : {}) },
    }),
    // Events have no academyId — only counted platform-wide.
    academyId
      ? Promise.resolve({ _sum: { amountPaise: 0 }, _count: 0 })
      : prisma.eventPayment.aggregate({ _sum: { amountPaise: true }, _count: true, where: { status: CAPTURED, capturedAt } }),
  ]);
  const by_source = {
    trial: { gross_paise: trial._sum.amountPaise ?? 0, count: trial._count },
    enrollment: { gross_paise: enrol._sum.amountPaise ?? 0, count: enrol._count },
    workshop: { gross_paise: workshop._sum.amountPaise ?? 0, count: workshop._count },
    event: { gross_paise: event._sum.amountPaise ?? 0, count: event._count },
  };
  const gross_paise =
    by_source.trial.gross_paise + by_source.enrollment.gross_paise + by_source.workshop.gross_paise + by_source.event.gross_paise;
  return { gross_paise, by_source };
}

// Net commission revenue (accrued − reversed) for a window, optionally scoped to one academy.
async function commissionFor({ from, to }: Window, academyId?: string) {
  const agg = await prisma.commissionLedger.aggregate({
    _sum: { commissionPaise: true, reversedPaise: true },
    where: { status: 'accrued', createdAt: { gte: from, lte: to }, ...(academyId ? { academyId } : {}) },
  });
  return (agg._sum.commissionPaise ?? 0) - (agg._sum.reversedPaise ?? 0);
}

// Trial → enrollment funnel for trials booked in the window (optionally one academy).
// A conversion is matched per (student, academy) pair — a trial at academy A only counts as
// converted if that student holds an enrollment at academy A (no cross-academy leakage). We
// report BOTH denominators: of trials BOOKED and of trials ATTENDED, how many convert.
// Denominators are distinct (student, academy) pairs, so a student who books two trials at the
// same academy counts once. Enrollment is checked at any time (a conversion can post-date the
// window), which is standard funnel practice.
async function conversionFunnel({ from, to }: Window, academyId?: string) {
  const empty = { booked: 0, attended: 0, booked_converted: 0, attended_converted: 0, booked_pct: 0, attended_pct: 0 };
  const trials = await prisma.trial.findMany({
    where: { trialAt: { gte: from, lte: to }, ...(academyId ? { academyId } : {}) },
    select: { userId: true, academyId: true, status: true },
  });
  if (trials.length === 0) return empty;

  const bookedPairs = new Set<string>();
  const attendedPairs = new Set<string>();
  for (const t of trials) {
    const key = `${t.userId}:${t.academyId}`;
    bookedPairs.add(key);
    if (t.status === 'attended') attendedPairs.add(key);
  }

  const userIds = [...new Set(trials.map((t) => t.userId))];
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: { in: userIds }, ...(academyId ? { batch: { academyId } } : {}) },
    select: { userId: true, batch: { select: { academyId: true } } },
  });
  const enrolledPairs = new Set(enrollments.map((e) => `${e.userId}:${e.batch.academyId}`));

  const bookedConverted = [...bookedPairs].filter((k) => enrolledPairs.has(k)).length;
  const attendedConverted = [...attendedPairs].filter((k) => enrolledPairs.has(k)).length;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

  return {
    booked: bookedPairs.size,
    attended: attendedPairs.size,
    booked_converted: bookedConverted,
    attended_converted: attendedConverted,
    booked_pct: pct(bookedConverted, bookedPairs.size),
    attended_pct: pct(attendedConverted, attendedPairs.size),
  };
}

// ---------- Platform analytics ----------

export async function platformAnalytics(windowDays = 30) {
  const window = rollingWindow(windowDays);
  const mauThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [gross, commissionPaise, conversion, mau, totalUsers, academyStatus, activeEnrollments, byCategory, geo, prevGross] =
    await Promise.all([
      grossFor(window),
      commissionFor(window),
      conversionFunnel(window),
      // MAU = users active in the last 30 days (independent of the selected window).
      prisma.user.count({ where: { lastActiveAt: { gte: mauThreshold } } }),
      prisma.user.count(),
      prisma.academy.groupBy({ by: ['status'], _count: true }),
      prisma.enrollment.count({ where: { status: 'active' } }),
      // Academies + verified count per art-form category (marketplace supply mix).
      prisma.academy.groupBy({ by: ['category'], _count: true }),
      // Geo: student distribution by city (User.location), top 8.
      prisma.user.groupBy({ by: ['location'], _count: true, where: { location: { not: null } }, orderBy: { _count: { location: 'desc' } }, take: 8 }),
      // Previous equal-length window for a GMV delta.
      grossFor({ from: new Date(window.from.getTime() - windowDays * 86400000), to: window.from }),
    ]);

  const status_counts: Record<string, number> = { pending_review: 0, approved: 0, rejected: 0, suspended: 0 };
  for (const r of academyStatus) status_counts[r.status] = r._count;

  return {
    window_days: windowDays,
    gmv_paise: gross.gross_paise,
    gmv_delta_paise: gross.gross_paise - prevGross.gross_paise,
    commission_paise: commissionPaise,
    by_source: gross.by_source,
    conversion,
    mau,
    total_users: totalUsers,
    active_enrollments: activeEnrollments,
    academies: { total: academyStatus.reduce((s, r) => s + r._count, 0), ...status_counts },
    by_category: byCategory.map((c) => ({ category: c.category as Category, academies: c._count })),
    by_geo: geo.map((g) => ({ location: g.location as string, students: g._count })),
  };
}

// ---------- Per-academy analytics ----------

// A compact roster of academies for the analytics picker (approved/suspended only — the ones
// that can actually transact).
export async function analyticsAcademies() {
  const academies = await prisma.academy.findMany({
    where: { status: { in: ['approved', 'suspended'] } },
    select: { id: true, name: true, category: true, status: true },
    orderBy: { name: 'asc' },
  });
  return { academies };
}

export async function academyAnalytics(academyId: string, windowDays = 90) {
  const window = rollingWindow(windowDays);

  const [
    academy,
    gross,
    commissionPaise,
    conversion,
    trialsBooked,
    trialsAttended,
    activeEnrollments,
    inactiveEnrollments,
    churnByReason,
    attendance,
  ] = await Promise.all([
    prisma.academy.findUnique({
      where: { id: academyId },
      select: { id: true, name: true, category: true, status: true, rating: true, ratingCount: true },
    }),
    grossFor(window, academyId),
    commissionFor(window, academyId),
    conversionFunnel(window, academyId),
    prisma.trial.count({ where: { academyId, trialAt: { gte: window.from, lte: window.to } } }),
    prisma.trial.count({ where: { academyId, status: 'attended', trialAt: { gte: window.from, lte: window.to } } }),
    prisma.enrollment.count({ where: { batch: { academyId }, status: 'active' } }),
    prisma.enrollment.count({ where: { batch: { academyId }, status: 'inactive' } }),
    // Churn: discontinuation reasons across this academy's enrollment periods.
    prisma.enrollmentPeriod.groupBy({
      by: ['discontinueReason'],
      _count: true,
      where: { discontinueReason: { not: null }, enrollment: { batch: { academyId } } },
    }),
    // Attendance over the same rolling window, off the one engine — so this number and the
    // academy app's percentages are the same number. Only finalised held sessions count.
    academyAttendanceTotals(academyId, window),
  ]);

  if (!academy) return null;

  const { present: presentN, expected: expectedN } = attendance;
  const absentN = Math.max(0, expectedN - presentN);
  const attendancePct = expectedN ? Math.round((presentN / expectedN) * 1000) / 10 : 0;

  return {
    academy: { id: academy.id, name: academy.name, category: academy.category, status: academy.status },
    window_days: windowDays,
    gmv_paise: gross.gross_paise,
    commission_paise: commissionPaise,
    by_source: gross.by_source,
    rating: academy.rating,
    rating_count: academy.ratingCount,
    trials: { booked: trialsBooked, attended: trialsAttended },
    conversion,
    enrollments: { active: activeEnrollments, inactive: inactiveEnrollments },
    attendance: { present: presentN, absent: absentN, pct: attendancePct },
    churn_by_reason: churnByReason.map((r) => ({ reason: r.discontinueReason as string, count: r._count })),
  };
}
