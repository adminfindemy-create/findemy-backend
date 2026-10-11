import type { Category } from '@prisma/client';
import { AppError } from '../../lib/app-error.js';
import { toWireMode, toDbMode } from '../../lib/mode.js';
import { attendancePct, tierOf } from '../../lib/attendance-tier.js';
import { statsForBatches } from '../attendance/stats.js';
import * as coachRepo from '../coaches/repo.js';
import * as repo from './repo.js';
import type { BatchScope } from '../../lib/scope.js';
import { learnerIdFromStudentRef, studentCard } from '../../lib/learner-access.js';

/**
 * ⚠️ `includeEarnings` is a real denial, not cosmetics. `dashboard.view` and `earnings.view` are
 * SEPARATE permissions, and a teacher holds the first but not the second — so without this the
 * dashboard would hand them the brand's monthly gross, net and commission through a route they
 * are allowed to call. The earnings aggregates are still computed (they are group-grained and
 * cheap to reuse for an owner), but they never leave here for a subject that cannot see them.
 */
export async function getDashboard(scope: BatchScope, includeEarnings: boolean) {
  const stats = await repo.getDashboardStats(scope);
  if (includeEarnings) return stats;
  const { earnings_summary: _earnings, ...rest } = stats;
  return rest;
}

// Group-wide (plan §5). Each row carries a branch chip — without it a five-branch owner can't
// tell which location a trial request is for.
export async function getInbox(
  groupId: string,
  status?: string,
  allowedIds?: string[],
  scope?: BatchScope,
) {
  const { items, counts } = await repo.getInboxItems(groupId, status, 20, allowedIds, scope);
  return {
    items: items.map((t) => ({
      id: t.id,
      learner_id: t.learnerId,
      student_name: studentCard(t.user, t.learner).name,
      student_age: studentCard(t.user, t.learner).age,
      guardian_name: t.user.name,
      batch_title: t.batch.title,
      scheduled_at: t.trialAt.toISOString(),
      status: t.status,
      student_phone: t.user.phone,
      level: t.batch.program.level,
      category: t.batch.category,
      coach_name: t.batch.coach?.name,
      trial_fee_paise: t.batch.trialFeePaise,
      branch_id: t.academy.id,
      branch_label: t.academy.branchLabel ?? t.academy.name,
    })),
    counts,
    next_cursor: null,
  };
}

export async function getActivity(scope: BatchScope) {
  const { attendedTrials, reviews, enrollments, workshopRegs } = await repo.getActivity(scope);
  const items = [
    ...attendedTrials.map((t) => ({
      id: `trial_${t.id}`,
      kind: 'trial_done' as const,
      icon_tone: 'jade' as const,
      title: `${t.learner.name || t.user.name} completed a trial`,
      subtitle: t.batch.title,
      at: (t.attendanceMarkedAt ?? t.trialAt).toISOString(),
      action: { label: 'Invite to enroll', route: `/students/${t.learnerId}` },
    })),
    ...reviews.map((r) => ({
      id: `review_${r.id}`,
      kind: 'review' as const,
      icon_tone: 'marigold' as const,
      title: `${r.user.name} left a ${r.rating}★ review`,
      subtitle: r.comment ?? undefined,
      at: r.createdAt.toISOString(),
      action: r.response ? undefined : { label: 'Respond', route: `/reviews/${r.id}/respond` },
    })),
    ...enrollments.map((e) => ({
      id: `enroll_${e.id}`,
      kind: 'enrollment' as const,
      icon_tone: 'persimmon' as const,
      title: `${e.learner.name || e.user.name} enrolled`,
      subtitle: e.batch.title,
      at: e.startedAt.toISOString(),
    })),
    ...workshopRegs.map((w) => ({
      id: `wsreg_${w.id}`,
      kind: 'workshop_reg' as const,
      icon_tone: 'rose' as const,
      title: `${w.user.name} registered for a workshop`,
      subtitle: w.workshop.title,
      at: w.createdAt.toISOString(),
    })),
  ];
  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { items: items.slice(0, 15) };
}

export async function getTrialDetail(trialId: string, scope: BatchScope) {
  const trial = await repo.getTrialDetail(trialId, scope);
  if (!trial) throw new AppError('NOT_FOUND', 404, 'Trial not found');
  return {
    trial: {
      id: trial.id,
      user_id: trial.userId,
      batch_id: trial.batchId,
      slot_id: trial.slotId,
      booking_id: trial.bookingId,
      trial_at: trial.trialAt.toISOString(),
      status: trial.status,
      attendance_marked_at: trial.attendanceMarkedAt?.toISOString() ?? null,
      marked_at: trial.attendanceMarkedAt?.toISOString() ?? undefined,
      attendance_marked_by_account_id: trial.attendanceMarkedByAccountId,
      created_at: trial.createdAt.toISOString(),
      batch_title: trial.batch.title,
      batch_level: trial.batch.program.level,
      category: trial.batch.category,
      // Nullable on purpose: a batch can genuinely sit without a coach assigned, and the client
      // says so in words rather than printing a dash.
      coach_name: trial.batch.coach?.name ?? null,
      slot_time: trial.trialAt.toISOString(), // S2.1: from trialAt (slots retired)
      scheduled_at: trial.trialAt.toISOString(),
      trial_fee_paise: trial.batch.trialFeePaise,
      mode: trial.batch.mode === 'online' ? 'online' : 'in-studio',
      payment_method:
        trial.booking?.payment?.status === 'captured'
          ? 'Paid online'
          : 'Pay at studio',
    },
    student: {
      id: trial.learnerId,
      user_id: trial.user.id,
      ...studentCard(trial.user, trial.learner),
      location: trial.user.location ?? undefined,
    },
  };
}

export async function getSchedule(scope: BatchScope, weekStart?: string) {
  const start = weekStart ? new Date(weekStart) : new Date();
  const days = await repo.getSchedule(scope, start);
  return { days };
}

export async function getBatches(scope: BatchScope) {
  const batches = await repo.getBatches(scope);
  return {
    items: batches.map((b) => ({
      id: b.id,
      title: b.title,
      category: b.category,
      name: b.name,
      // `level` is the parent program's — kept on the batch payload for existing consumers.
      level: b.program.level,
      min_age: b.minAge ?? null,
      max_age: b.maxAge ?? null,
      session_format: b.sessionFormat,
      gender: b.gender,
      description: b.description ?? null,
      things_to_know: b.thingsToKnow ?? [],
      capacity: b.capacity,
      trial_fee_paise: b.trialFeePaise,
      monthly_fee_paise: b.monthlyFeePaise,
      quarterly_discount_bps: b.quarterlyDiscountBps,
      annual_discount_bps: b.annualDiscountBps,
      sessions_per_month: b.sessionsPerMonth,
      status: b.status,
      mode: toWireMode(b.mode),
      trial_spots: Math.max(0, b.capacity - b._count.enrollments),
      coach_name: b.coach.name,
      timings: b.timings.map((t) => ({
        day_of_week: t.dayOfWeek,
        start_time: t.startTime,
        duration_min: t.durationMin,
      })),
    })),
  };
}

export async function getBatch(id: string, scope: BatchScope) {
  const batch = await repo.getBatchById(id, scope);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  return {
    batch: {
      id: batch.id,
      title: batch.title,
      category: batch.category,
      name: batch.name,
      level: batch.program.level,
      min_age: batch.minAge ?? null,
      max_age: batch.maxAge ?? null,
      session_format: batch.sessionFormat,
      gender: batch.gender,
      description: batch.description ?? null,
      things_to_know: batch.thingsToKnow ?? [],
      capacity: batch.capacity,
      trial_fee_paise: batch.trialFeePaise,
      monthly_fee_paise: batch.monthlyFeePaise,
      quarterly_discount_bps: batch.quarterlyDiscountBps,
      annual_discount_bps: batch.annualDiscountBps,
      sessions_per_month: batch.sessionsPerMonth,
      status: batch.status,
      mode: toWireMode(batch.mode),
      trial_spots: Math.max(0, batch.capacity - batch._count.enrollments),
      coach_id: batch.coachId,
      coach_name: batch.coach.name,
      timings: batch.timings.map((t) => ({
        day_of_week: t.dayOfWeek,
        start_time: t.startTime,
        duration_min: t.durationMin,
      })),
    },
  };
}

export async function createBatch(
  academyId: string,
  data: {
    program_id: string;
    coach_id: string;
    name: string;
    min_age?: number | null;
    max_age?: number | null;
    session_format?: string;
    gender?: string;
    capacity: number;
    trial_fee_paise: number;
    monthly_fee_paise: number;
    quarterly_discount_bps?: number;
    annual_discount_bps?: number;
    sessions_per_month?: number;
    mode?: string;
    timings?: { day_of_week: number; start_time: string; duration_min: number }[];
  },
) {
  // Invariants §3.1 / §3.2: the program AND the coach must belong to the same BRAND as the
  // branch this batch is being created at. Programs and coaches are group-level now, so this
  // is the only thing standing between a mis-sent id and a batch permanently pointing at
  // another brand's catalog — silent, unrecoverable corruption.
  const groupId = await repo.groupIdForBranch(academyId);
  if (!groupId) throw new AppError('NOT_FOUND', 404, 'Branch not found');

  // Every batch is created under a program. Identity/marketing fields (title, category,
  // description, things_to_know) are owned by the program and denormalized onto the batch.
  const program = await repo.getProgramById(data.program_id, groupId);
  if (!program) throw new AppError('NOT_FOUND', 404, 'Program not found in this academy');

  const owns = await coachRepo.coachBelongsToGroup(data.coach_id, groupId);
  if (!owns) throw new AppError('NOT_FOUND', 404, 'Coach not found in this academy');

  const batch = await repo.createBatch({
    academyId,
    programId: program.id,
    coachId: data.coach_id,
    // `level` now lives on the program, so the batch label is its academy-authored name.
    title: `${program.title} · ${data.name}`,
    category: program.category,
    name: data.name,
    ...(data.min_age !== undefined ? { minAge: data.min_age } : {}),
    ...(data.max_age !== undefined ? { maxAge: data.max_age } : {}),
    ...(data.session_format ? { sessionFormat: data.session_format } : {}),
    ...(data.gender ? { gender: data.gender } : {}),
    description: program.description ?? undefined,
    thingsToKnow: program.thingsToKnow,
    capacity: data.capacity,
    trialFeePaise: data.trial_fee_paise,
    monthlyFeePaise: data.monthly_fee_paise,
    ...(data.quarterly_discount_bps !== undefined ? { quarterlyDiscountBps: data.quarterly_discount_bps } : {}),
    ...(data.annual_discount_bps !== undefined ? { annualDiscountBps: data.annual_discount_bps } : {}),
    ...(data.sessions_per_month !== undefined ? { sessionsPerMonth: data.sessions_per_month } : {}),
    // canonical wire Mode → DB BatchMode (S1.3 / Option A)
    ...(data.mode ? { mode: toDbMode(data.mode) } : {}),
  });
  if (data.timings) {
    await repo.replaceBatchTimings(
      batch.id,
      data.timings.map((t) => ({ dayOfWeek: t.day_of_week, startTime: t.start_time, durationMin: t.duration_min })),
    );
  }
  return { batch: { id: batch.id } };
}

export async function updateBatch(
  id: string,
  academyId: string,
  data: {
    coach_id?: string;
    title?: string;
    category?: string;
    name?: string;
    min_age?: number | null;
    max_age?: number | null;
    session_format?: string;
    gender?: string;
    description?: string;
    things_to_know?: string[];
    capacity?: number;
    trial_fee_paise?: number;
    monthly_fee_paise?: number;
    quarterly_discount_bps?: number;
    annual_discount_bps?: number;
    sessions_per_month?: number;
    status?: string;
    mode?: string;
    timings?: { day_of_week: number; start_time: string; duration_min: number }[];
  },
) {
  const prismaData: Record<string, unknown> = {};
  if (data.description !== undefined) prismaData.description = data.description;
  if (data.things_to_know !== undefined) prismaData.thingsToKnow = data.things_to_know;
  if (data.coach_id !== undefined) {
    // Invariant §3.2 again on update — reassigning a coach is the other way a batch can end
    // up pointing at another brand.
    const groupId = await repo.groupIdForBranch(academyId);
    if (!groupId) throw new AppError('NOT_FOUND', 404, 'Branch not found');
    const owns = await coachRepo.coachBelongsToGroup(data.coach_id, groupId);
    if (!owns) throw new AppError('NOT_FOUND', 404, 'Coach not found in this academy');
    prismaData.coachId = data.coach_id;
  }
  if (data.title !== undefined) prismaData.title = data.title;
  if (data.category !== undefined) prismaData.category = data.category;
  if (data.name !== undefined) prismaData.name = data.name;
  if (data.min_age !== undefined) prismaData.minAge = data.min_age;
  if (data.max_age !== undefined) prismaData.maxAge = data.max_age;
  if (data.session_format !== undefined) prismaData.sessionFormat = data.session_format;
  if (data.gender !== undefined) prismaData.gender = data.gender;
  if (data.capacity !== undefined) prismaData.capacity = data.capacity;
  if (data.trial_fee_paise !== undefined) prismaData.trialFeePaise = data.trial_fee_paise;
  if (data.monthly_fee_paise !== undefined) prismaData.monthlyFeePaise = data.monthly_fee_paise;
  if (data.quarterly_discount_bps !== undefined) prismaData.quarterlyDiscountBps = data.quarterly_discount_bps;
  if (data.annual_discount_bps !== undefined) prismaData.annualDiscountBps = data.annual_discount_bps;
  if (data.sessions_per_month !== undefined) prismaData.sessionsPerMonth = data.sessions_per_month;
  if (data.status !== undefined) prismaData.status = data.status;
  if (data.mode !== undefined) prismaData.mode = toDbMode(data.mode); // canonical wire → DB
  await repo.updateBatch(id, academyId, prismaData);
  if (data.timings !== undefined) {
    await repo.replaceBatchTimings(
      id,
      data.timings.map((t) => ({ dayOfWeek: t.day_of_week, startTime: t.start_time, durationMin: t.duration_min })),
    );
  }
  return { batch: { id } };
}

export async function deleteBatch(id: string, academyId: string) {
  await repo.deleteBatch(id, academyId);
  return {};
}

// --- Programs (academy-authored offerings that own batches) ---

function toStudioBatch(b: any) {
  return {
    id: b.id,
    program_id: b.programId,
    title: b.title,
    category: b.category,
    name: b.name,
    min_age: b.minAge ?? null,
    max_age: b.maxAge ?? null,
    session_format: b.sessionFormat,
    gender: b.gender,
    capacity: b.capacity,
    trial_fee_paise: b.trialFeePaise,
    monthly_fee_paise: b.monthlyFeePaise,
    quarterly_discount_bps: b.quarterlyDiscountBps,
    annual_discount_bps: b.annualDiscountBps,
    sessions_per_month: b.sessionsPerMonth,
    status: b.status,
    mode: toWireMode(b.mode),
    trial_spots: Math.max(0, b.capacity - b._count.enrollments),
    coach_id: b.coachId,
    coach_name: b.coach?.name ?? null,
    timings: (b.timings ?? []).map((t: any) => ({
      day_of_week: t.dayOfWeek,
      start_time: t.startTime,
      duration_min: t.durationMin,
    })),
  };
}

// Group-wide: a program is authored once for the brand. `academyId` narrows only the
// `batch_count` to the active branch, so the list answers "what does the brand offer, and how
// much of it does THIS location run".
export async function getPrograms(groupId: string, academyId?: string, allowedIds?: string[]) {
  const programs = await repo.getPrograms(groupId, academyId, allowedIds);
  return {
    items: programs.map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      level: p.level,
      description: p.description ?? null,
      things_to_know: p.thingsToKnow ?? [],
      batch_count: p._count.batches,
      cover_url: (p as any).media?.[0]?.url ?? null,
      created_at: p.createdAt.toISOString(),
    })),
  };
}

export async function getProgramDetail(id: string, groupId: string, academyId?: string) {
  const program = await repo.getProgramById(id, groupId, academyId);
  if (!program) throw new AppError('NOT_FOUND', 404, 'Program not found');
  return {
    program: {
      id: program.id,
      title: program.title,
      category: program.category,
      level: program.level,
      description: program.description ?? null,
      things_to_know: program.thingsToKnow ?? [],
      media: (program as any).media?.map((m: any) => ({ url: m.url, type: m.type })) ?? [],
      created_at: program.createdAt.toISOString(),
    },
    batches: program.batches.map(toStudioBatch),
  };
}

export async function createProgram(
  groupId: string,
  data: { title: string; category: string; level: string; description?: string; things_to_know?: string[]; media?: { url: string; type: string }[] },
) {
  const program = await repo.createProgram({
    groupId,
    title: data.title,
    category: data.category,
    level: data.level,
    description: data.description,
    thingsToKnow: data.things_to_know,
    media: data.media,
  });
  return { program: { id: program.id } };
}

export async function updateProgram(
  id: string,
  groupId: string,
  data: { title?: string; level?: string; description?: string; things_to_know?: string[]; media?: { url: string; type: string }[] },
) {
  const prismaData: Record<string, unknown> = {};
  if (data.title !== undefined) prismaData.title = data.title;
  if (data.level !== undefined) prismaData.level = data.level;
  if (data.description !== undefined) prismaData.description = data.description;
  if (data.things_to_know !== undefined) prismaData.thingsToKnow = data.things_to_know;
  await repo.updateProgram(id, groupId, prismaData, data.media);
  return { program: { id } };
}

export async function deleteProgram(id: string, groupId: string) {
  // A program is deletable only when it has no batches (plan §8 — retire by stopping batches first).
  const count = await repo.countProgramBatches(id);
  if (count > 0) {
    throw new AppError('CONFLICT', 409, 'Delete or discontinue this program’s batches first');
  }
  await repo.deleteProgram(id, groupId);
  return {};
}

export async function getStudents(
  scope: BatchScope,
  q?: string,
  batchId?: string,
  attendanceTier?: 'active' | 'irregular' | 'inactive',
) {
  const enrollments = await repo.getStudents(scope, q, 20, batchId, attendanceTier);
  // One row per learner: siblings are separate students who share a guardian's phone.
  const userMap = new Map();
  for (const e of enrollments) {
    if (!userMap.has(e.learnerId)) {
      const card = studentCard(e.user, e.learner);
      userMap.set(e.learnerId, {
        id: e.learnerId,
        user_id: e.userId,
        learner_id: e.learnerId,
        name: card.name,
        phone: card.phone,
        age: card.age,
        guardian_name: card.guardian_name,
        batches: [],
        // S4.1: % + tier for the (filtered) batch — the first enrolment row carries it.
        attendance_pct: e.attendance_pct,
        tier: e.tier,
        status: 'active',
      });
    }
    userMap.get(e.learnerId).batches.push({ title: e.batch.title, category: e.batch.category });
  }
  return { items: Array.from(userMap.values()), next_cursor: null };
}

// `studentId` is a learner id; older academy-app builds pass the account's user id.
export async function getStudent(studentId: string, scope: BatchScope) {
  const learnerId = await learnerIdFromStudentRef({ user_id: studentId });
  const { learner, user, enrollments, attendance, trials } = await repo.getStudentById(learnerId, scope);
  if (!learner || !user) throw new AppError('NOT_FOUND', 404, 'Student not found');
  // `prisma.user.findUnique` is deliberately UNSCOPED — it has to be, since a User is global —
  // so a student with no enrolment, attendance or trial in this subject's batches would
  // otherwise render as a name with three empty lists. That is a disclosure ("this person
  // exists"), so it is a 404 instead.
  if (enrollments.length === 0 && attendance.length === 0 && trials.length === 0) {
    throw new AppError('NOT_FOUND', 404, 'Student not found');
  }

  // Overall tier across the student's active enrolments, from the real record: their present
  // count over the finalised held sessions they were expected at, summed across batches.
  const stats = await statsForBatches(enrollments.filter((e) => e.status === 'active').map((e) => e.batchId));
  let totalPresent = 0;
  let totalExpected = 0;
  for (const e of enrollments) {
    if (e.status !== 'active') continue;
    const stat = stats.get(e.batchId)?.per_student.find((s) => s.learner_id === learnerId);
    totalPresent += stat?.present ?? 0;
    totalExpected += stat?.expected ?? 0;
  }
  const overallPct = attendancePct(totalPresent, totalExpected);

  return {
    student: {
      id: learner.id,
      user_id: user.id,
      ...studentCard(user, learner),
      location: user.location,
      attendance_pct: overallPct,
      tier: tierOf(overallPct),
      status: 'active',
    },
    enrollments: enrollments.map((e) => ({
      id: e.id,
      batch_id: e.batchId,
      batch_title: e.batch.title,
      category: e.batch.category,
      monthly_fee_paise: e.batch.monthlyFeePaise,
      started_at: e.startedAt.toISOString(),
      current_period_end: e.periods[0]?.endDate?.toISOString(),
      status: e.status,
    })),
    trial_history: trials.map((t) => ({
      id: t.id,
      batch_title: t.batch.title,
      status: t.status,
      trial_at: t.trialAt.toISOString(),
    })),
    attendance_history: attendance.map((a) => ({
      date: a.date.toISOString().slice(0, 10),
      batch_title: a.batch.title,
      present: a.present,
    })),
  };
}

export async function getBatchStudents(batchId: string, scope: BatchScope) {
  const students = await repo.getBatchStudents(batchId, scope);
  return { students };
}

export async function getReviews(
  scope: BatchScope,
  filter?: 'all' | 'needs_reply' | 'replied' | '5' | 'lte3',
) {
  const [reviews, summary] = await Promise.all([
    repo.getReviews(scope, filter),
    repo.getReviewsSummary(scope),
  ]);
  const sessionCounts = await repo.getAttendanceCountsFor(
    reviews.map((r) => ({ userId: r.userId, batchId: r.batchId })),
  );
  return {
    items: reviews.map((r) => ({
      id: r.id,
      student_name: r.user.name,
      rating: r.rating,
      comment: r.comment,
      response: r.response,
      created_at: r.createdAt.toISOString(),
      responded_at: r.respondedAt?.toISOString(),
      batch_title: r.batch.title,
      session_count: sessionCounts.get(`${r.userId}:${r.batchId}`) ?? 0,
      flagged: r.rating <= 3 && !r.response,
    })),
    summary,
    next_cursor: null,
  };
}

export async function getReviewsSummary(scope: BatchScope) {
  return repo.getReviewsSummary(scope);
}

export async function respondToReview(id: string, academyId: string, response: string) {
  await repo.respondToReview(id, academyId, response);
  return { review: { id } };
}

export async function getEarnings(academyId: string, opts: repo.EarningsOpts = {}) {
  const earnings = await repo.getEarnings(academyId, opts);
  // Per-branch split of the SAME window. Every branch settles into one account (see
  // branches/new.tsx), so this is the only place the owner can see which location the money
  // actually came from. Brand-wide, not scoped to the branch being viewed.
  const groupId = await repo.groupIdForBranch(academyId);
  const byBranch = groupId
    ? await repo.getBranchEarnings(groupId, new Date(earnings.window_start), new Date(earnings.window_end))
    : [];
  // S7: settlement — rolling reserve + recovery owed, and net payable after netting.
  const { getSettlement } = await import('../settlement/service.js');
  const settlement = await getSettlement(academyId);
  const netPayable = Math.max(0, (earnings.net_paise ?? 0) - settlement.outstanding_recovery_paise);
  return { ...earnings, by_branch: byBranch, settlement, net_payable_paise: netPayable };
}

type NotificationChannelPrefs = { push: boolean; email: boolean; whatsapp: boolean };
type GranularNotifications = {
  new_trial: NotificationChannelPrefs;
  classes: { reminder_30min: boolean; attendance_reminder: boolean };
  // No `leaderboard` / `reels`: both are post-MVP features (Phase 2), so a preference for
  // them was a switch on a notification that can never fire.
  reviews_activity: { new_review: boolean };
  quiet_hours: { enabled: boolean; start: string; end: string };
};

function defaultNotifications(newTrial: boolean, review: boolean): GranularNotifications {
  return {
    new_trial: { push: newTrial, email: false, whatsapp: false },
    classes: { reminder_30min: true, attendance_reminder: true },
    reviews_activity: { new_review: review },
    quiet_hours: { enabled: false, start: '22:00', end: '07:00' },
  };
}

// Reads two rows on purpose: per-login notification prefs from `academy_settings`, brand
// contact/privacy from `academy_group_settings`. See academy-staff-roles.md invariant 5.
export async function getSettings(accountId: string, groupId?: string) {
  const [settings, brand] = await Promise.all([
    repo.getSettings(accountId),
    groupId ? repo.getGroupSettings(groupId) : Promise.resolve(null),
  ]);
  const stored = (settings?.notificationPrefs as Partial<GranularNotifications> | null) ?? null;
  const base = defaultNotifications(
    settings?.notificationsNewTrial ?? true,
    settings?.notificationsReview ?? true,
  );
  const notifications: GranularNotifications = {
    new_trial: { ...base.new_trial, ...stored?.new_trial },
    classes: { ...base.classes, ...stored?.classes },
    reviews_activity: { ...base.reviews_activity, ...stored?.reviews_activity },
    quiet_hours: {
      enabled: settings?.quietHoursEnabled ?? base.quiet_hours.enabled,
      start: settings?.quietStart ?? base.quiet_hours.start,
      end: settings?.quietEnd ?? base.quiet_hours.end,
    },
  };
  return {
    notifications,
    privacy: { show_phone: brand?.privacyShowPhone ?? false },
    contact: {
      email: brand?.contactEmail ?? undefined,
      whatsapp: brand?.contactWhatsapp ?? undefined,
    },
  };
}

// The ONE handler that maps to two permission keys, because its body mixes a per-login fact
// (notification prefs) with three brand facts. The route checks `settings.brand.edit` before
// calling with `brandFields` present — see modules/studio/routes.ts.
export async function updateSettings(
  accountId: string,
  groupId: string | undefined,
  data: {
    notifications?: {
      new_trial?: Partial<NotificationChannelPrefs>;
      classes?: Partial<{ reminder_30min: boolean; attendance_reminder: boolean }>;
      reviews_activity?: Partial<{ new_review: boolean }>;
      quiet_hours?: Partial<{ enabled: boolean; start: string; end: string }>;
    };
    privacy?: { show_phone?: boolean };
    contact?: { email?: string; whatsapp?: string };
  },
) {
  const current = await getSettings(accountId, groupId);
  const merged: GranularNotifications = {
    new_trial: { ...current.notifications.new_trial, ...data.notifications?.new_trial },
    classes: { ...current.notifications.classes, ...data.notifications?.classes },
    reviews_activity: { ...current.notifications.reviews_activity, ...data.notifications?.reviews_activity },
    quiet_hours: { ...current.notifications.quiet_hours, ...data.notifications?.quiet_hours },
  };

  const prismaData: Record<string, unknown> = {
    notificationPrefs: merged,
    // keep legacy boolean columns in sync for back-compat
    notificationsNewTrial: merged.new_trial.push,
    notificationsReview: merged.reviews_activity.new_review,
    quietHoursEnabled: merged.quiet_hours.enabled,
    quietStart: merged.quiet_hours.start,
    quietEnd: merged.quiet_hours.end,
  };
  const brandData: Record<string, unknown> = {};
  if (data.privacy?.show_phone !== undefined) brandData.privacyShowPhone = data.privacy.show_phone;
  if (data.contact?.email !== undefined) brandData.contactEmail = data.contact.email;
  if (data.contact?.whatsapp !== undefined) brandData.contactWhatsapp = data.contact.whatsapp;

  await repo.upsertSettings(accountId, prismaData);
  if (groupId && Object.keys(brandData).length) {
    await repo.upsertGroupSettings(groupId, brandData);
  }
  return { settings: await getSettings(accountId, groupId) };
}

/** True when a settings body touches a BRAND fact and therefore needs `settings.brand.edit`. */
export function touchesBrandSettings(data: {
  privacy?: { show_phone?: boolean };
  contact?: { email?: string; whatsapp?: string };
}): boolean {
  return (
    data.privacy?.show_phone !== undefined ||
    data.contact?.email !== undefined ||
    data.contact?.whatsapp !== undefined
  );
}

// The BRANCH, plus its brand and its payee — read-only for the financial half. Shared
// financial details are deliberately exposed here (an owner must be able to SEE which bank
// account a branch settles to) but are never writable from a branch screen: see updateAcademy.
export async function getAcademy(academyId: string) {
  const academy = await repo.getAcademyById(academyId);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  const entity = academy.financialEntity;
  return {
    academy: {
      id: academy.id,
      group_id: academy.groupId,
      group_name: academy.group.name,
      branch_label: academy.branchLabel,
      name: academy.name,
      category: academy.category,
      address: academy.address,
      lat: academy.lat,
      lng: academy.lng,
      rating: academy.rating,
      rating_count: academy.ratingCount,
      status: academy.status,
      verified: academy.verified,
      bio: academy.bio,
      tagline: academy.tagline,
      modes_offered: academy.modesOffered,
      specialities: academy.specialities,
      categories: academy.categories,
      amenities: academy.amenities,
      images: academy.images,
      // Which payee this branch settles through. Read-only here — edit it under group
      // settings via /studio/financial-entities.
      financial_entity_id: academy.financialEntityId,
    },
    // Shared across every branch on the same entity. Present for display only; a write to any
    // of it through PUT /studio/academy is rejected.
    financial_entity: entity
      ? {
          id: entity.id,
          label: entity.label,
          bank_kyc_status: entity.bankKycStatus,
          bank_account_number: entity.bankAccountNumber,
          bank_ifsc: entity.bankIfsc,
          bank_holder_name: entity.bankHolderName,
          pan_number: entity.panNumber,
          pan_image_url: entity.panImageUrl,
          aadhaar_last4: entity.aadhaarLast4,
          aadhaar_image_url: entity.aadhaarImageUrl,
          business_doc_urls: entity.businessDocUrls ?? [],
          gst_registrations: entity.gstRegistrations.map((g) => ({
            id: g.id,
            gst_number: g.gstNumber,
            state: g.state,
          })),
          // How many branches share this payee — the warning a client shows before an edit.
          branch_count: entity._count.branches,
        }
      : null,
  };
}

// Branch identity and policy ONLY.
//
// This endpoint deliberately no longer accepts PAN / Aadhaar / GST / bank fields. Those are
// properties of the payee, not of a location, and several branches can share one payee — so
// editing them from a branch screen meant Delhi changing the bank account and silently
// changing Gurgaon's. They now live behind /studio/financial-entities, which is group-scoped
// and states how many branches an edit affects. See plan §6.
export async function updateAcademy(academyId: string, data: {
  name?: string;
  branch_label?: string;
  category?: string;
  categories?: string[];
  address?: string;
  bio?: string;
  tagline?: string;
  specialities?: string[];
  amenities?: string[];
  modes_offered?: ('in_studio' | 'online' | 'home_visit')[];
  lat?: number;
  lng?: number;
  images?: string[];
}) {
  const prismaData: Record<string, unknown> = {};
  if (data.name !== undefined) prismaData.name = data.name;
  // Relabelling a branch re-composes its display name, the same way `createBranch` composed it
  // and the same way a brand rename re-composes it (see repo.renameGroup). Without this the
  // label said "Saket" while the name every learner searched still said "Andheri West".
  // An explicit `name` in the same request still wins — it is the more specific instruction.
  if (data.branch_label !== undefined) {
    prismaData.branchLabel = data.branch_label;
    if (data.name === undefined) {
      const current = await repo.getAcademyById(academyId);
      const brand = current?.group?.name;
      if (brand) prismaData.name = `${brand} — ${data.branch_label}`;
    }
  }
  if (data.category !== undefined) prismaData.category = data.category;
  // `categories` must always contain the primary, whichever of the two the client sent, or a
  // branch could end up invisible under its own headline art form.
  if (data.categories !== undefined || data.category !== undefined) {
    const primary = data.category ?? (await repo.getAcademyById(academyId))?.category;
    const listed = data.categories ?? (primary ? [primary] : []);
    prismaData.categories = Array.from(new Set([...(primary ? [primary] : []), ...listed]));
  }
  if (data.address !== undefined) prismaData.address = data.address;
  if (data.bio !== undefined) prismaData.bio = data.bio;
  if (data.tagline !== undefined) prismaData.tagline = data.tagline;
  if (data.specialities !== undefined) prismaData.specialities = data.specialities;
  if (data.amenities !== undefined) prismaData.amenities = data.amenities;
  if (data.modes_offered !== undefined) prismaData.modesOffered = data.modes_offered;
  if (data.lat !== undefined) prismaData.lat = data.lat;
  if (data.lng !== undefined) prismaData.lng = data.lng;
  if (data.images !== undefined) prismaData.images = data.images;
  await repo.updateAcademy(academyId, prismaData);
  return await getAcademy(academyId);
}
// --- Branches + financial entities (multi-branch) ---

// Every location of the brand. Group-scoped by design: this backs the branch switcher, which
// must show branches you are NOT currently acting on.
// §5.3: this is one of the four academy reads that answer GROUP-wide and therefore bypass
// `academy_id` entirely. Left alone, a branch-scoped manager's switcher would list branches
// they cannot select — and every selection would 403. `allowedIds` is the narrowing.
export async function getBranches(groupId: string, activeAcademyId?: string, allowedIds?: string[]) {
  const [group, branches] = await Promise.all([
    repo.getGroup(groupId),
    repo.listBranches(groupId, allowedIds),
  ]);
  return {
    group: group
      ? {
          id: group.id,
          name: group.name,
          category: group.category,
          bio: group.bio,
          tagline: group.tagline,
          specialities: group.specialities,
        }
      : null,
    active_branch_id: activeAcademyId ?? null,
    items: branches.map((b) => ({
      id: b.id,
      name: b.name,
      branch_label: b.branchLabel,
      address: b.address,
      lat: b.lat,
      lng: b.lng,
      status: b.status,
      verified: b.verified,
      rating: b.rating,
      rating_count: b.ratingCount,
      images: b.images,
      financial_entity_id: b.financialEntityId,
      active_batch_count: b._count.batches,
      is_active: b.id === activeAcademyId,
      created_at: b.createdAt.toISOString(),
    })),
  };
}

/** The brand's before-state, for the audit entry the route writes around a rename. */
export async function getGroupForAudit(groupId: string) {
  const group = await repo.getGroup(groupId);
  return group ? { name: group.name } : null;
}

/**
 * The brand itself. Group-scoped, so it is deliberately NOT reachable from a branch screen —
 * renaming it changes what every branch is called and what learners find in search.
 *
 * Until this existed, `AcademyGroup.name` was written exactly once, at signup, and had no update
 * path at all: the Academy profile screen's "name" field writes `Academy.name` (the branch's own
 * composed display name), so an owner renaming their academy saw nothing change on the Studio
 * tab, which reads the group.
 */
export async function updateGroup(groupId: string, data: { name?: string }) {
  const group = await repo.getGroup(groupId);
  if (!group) throw new AppError('NOT_FOUND', 404, 'Academy group not found');

  const name = data.name?.trim();
  if (!name) throw new AppError('VALIDATION', 400, 'Brand name is required');
  // Nothing to do, and no reason to rewrite every branch row for a no-op save.
  if (name === group.name) return { group, branches_renamed: 0 };

  const { group: updated, branchCount } = await repo.renameGroup(groupId, name);
  return { group: updated, branches_renamed: branchCount };
}

export async function createBranch(
  groupId: string,
  data: {
    branch_label: string;
    address: string;
    lat?: number;
    lng?: number;
    category?: string;
    images?: string[];
    financial_entity_id?: string;
    create_financial_entity?: boolean;
    financial_entity_label?: string;
  },
) {
  const group = await repo.getGroup(groupId);
  if (!group) throw new AppError('NOT_FOUND', 404, 'Academy group not found');

  // Invariant §3.3: the branch's financial entity must belong to the branch's group.
  // Resolving it through the group is what enforces that — an id from another brand simply
  // does not resolve.
  let financialEntityId: string | undefined;
  if (data.create_financial_entity) {
    financialEntityId = undefined; // repo creates a fresh one inside the transaction
  } else if (data.financial_entity_id) {
    const entity = await repo.findFinancialEntity(data.financial_entity_id, groupId);
    if (!entity) throw new AppError('NOT_FOUND', 404, 'Financial entity not found in this group');
    financialEntityId = entity.id;
  } else {
    // Neither reuse nor create was stated. Default to the group's only entity when that is
    // unambiguous; otherwise make the owner choose rather than guessing which payee gets
    // this location's money.
    const entities = await repo.listFinancialEntities(groupId);
    if (entities.length === 1) {
      financialEntityId = entities[0].id;
    } else if (entities.length > 1) {
      throw new AppError(
        'VALIDATION',
        400,
        'This academy has more than one financial setup — choose which one this branch belongs to',
      );
    }
  }

  // The public profile the owner has already written for this brand. A new location starts from
  // it rather than from a blank page — the branch form asks for a label, an address and a pin,
  // and nothing a learner reads.
  const primary = await repo.findGroupPrimaryBranch(groupId);

  const branch = await repo.createBranch({
    groupId,
    // The composed display name. `Academy.name` keeps its current meaning — text search and
    // every display path read it — with `branchLabel` carrying the location on its own.
    name: `${group.name} — ${data.branch_label}`,
    branchLabel: data.branch_label,
    // Prefilled from the brand unless the owner says otherwise.
    category: (data.category ?? group.category) as Category,
    address: data.address,
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    images: data.images,
    bio: primary?.bio ?? null,
    tagline: primary?.tagline ?? null,
    specialities: primary?.specialities ?? [],
    modesOffered: primary?.modesOffered ?? [],
    financialEntityId,
    newEntityLabel: data.financial_entity_label,
  });

  return getAcademy(branch.id);
}

export async function setDefaultBranch(accountId: string, groupId: string, academyId: string) {
  // Never let an account default onto a branch outside its own brand.
  const branches = await repo.listBranches(groupId);
  if (!branches.some((b) => b.id === academyId)) {
    throw new AppError('FORBIDDEN', 403, 'Branch not in your academy group');
  }
  await repo.setDefaultBranch(accountId, academyId);
  return { default_academy_id: academyId };
}

function shapeEntity(e: {
  id: string;
  label: string | null;
  bankKycStatus: string;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankHolderName: string | null;
  panNumber: string | null;
  panImageUrl: string | null;
  aadhaarLast4: string | null;
  aadhaarImageUrl: string | null;
  businessDocUrls: string[];
  reserveRateBps: number;
  gstRegistrations: { id: string; gstNumber: string; state: string | null }[];
  branches: { id: string; name: string; branchLabel: string | null }[];
}) {
  return {
    id: e.id,
    label: e.label,
    bank_kyc_status: e.bankKycStatus,
    bank_account_number: e.bankAccountNumber,
    bank_ifsc: e.bankIfsc,
    bank_holder_name: e.bankHolderName,
    pan_number: e.panNumber,
    pan_image_url: e.panImageUrl,
    aadhaar_last4: e.aadhaarLast4,
    aadhaar_image_url: e.aadhaarImageUrl,
    business_doc_urls: e.businessDocUrls ?? [],
    reserve_rate_bps: e.reserveRateBps,
    gst_registrations: e.gstRegistrations.map((g) => ({
      id: g.id,
      gst_number: g.gstNumber,
      state: g.state,
    })),
    // The branches an edit here would affect — a client should say so before saving.
    branches: e.branches.map((b) => ({
      id: b.id,
      name: b.name,
      branch_label: b.branchLabel,
    })),
  };
}

export async function getFinancialEntities(groupId: string) {
  const entities = await repo.listFinancialEntities(groupId);
  return { items: entities.map(shapeEntity) };
}

export async function updateFinancialEntity(
  groupId: string,
  id: string,
  data: {
    label?: string;
    bank_account_number?: string;
    bank_ifsc?: string;
    bank_holder_name?: string;
    pan_number?: string;
    pan_image_url?: string;
    aadhaar_last4?: string;
    aadhaar_image_url?: string;
    business_doc_urls?: string[];
    gst_registrations?: { gst_number: string; state?: string }[];
  },
) {
  // Scoping the lookup by group is the authorization check: an entity id from another brand
  // does not resolve, so this cannot be used to read or rewrite a stranger's bank details.
  const entity = await repo.findFinancialEntity(id, groupId);
  if (!entity) throw new AppError('NOT_FOUND', 404, 'Financial entity not found');

  const prismaData: Record<string, unknown> = {};
  if (data.label !== undefined) prismaData.label = data.label;
  if (data.bank_account_number !== undefined) prismaData.bankAccountNumber = data.bank_account_number;
  if (data.bank_ifsc !== undefined) prismaData.bankIfsc = data.bank_ifsc;
  if (data.bank_holder_name !== undefined) prismaData.bankHolderName = data.bank_holder_name;
  if (data.pan_number !== undefined) prismaData.panNumber = data.pan_number;
  if (data.pan_image_url !== undefined) prismaData.panImageUrl = data.pan_image_url;
  if (data.aadhaar_last4 !== undefined) prismaData.aadhaarLast4 = data.aadhaar_last4 || null;
  if (data.aadhaar_image_url !== undefined) prismaData.aadhaarImageUrl = data.aadhaar_image_url;
  if (data.business_doc_urls !== undefined) prismaData.businessDocUrls = data.business_doc_urls;

  // Re-submitting bank details after a failure puts the entity back in the KYC queue rather
  // than leaving it stuck on `failed` with nobody re-reviewing it.
  const bankChanged =
    data.bank_account_number !== undefined ||
    data.bank_ifsc !== undefined ||
    data.bank_holder_name !== undefined;
  if (bankChanged && entity.bankKycStatus === 'failed') {
    prismaData.bankKycStatus = 'unverified';
  }

  const updated = await repo.updateFinancialEntity(
    id,
    prismaData,
    data.gst_registrations?.map((g) => ({ gstNumber: g.gst_number, state: g.state })),
  );
  return { financial_entity: updated ? shapeEntity(updated) : null };
}

/**
 * Who owes what, and when — the academy-side counterpart to the student's renewal reminders.
 *
 * States are DERIVED here rather than stored, so they cannot go stale between lifecycle runs:
 * `workers/enrollment-lifecycle.ts` moves a period active → grace → expired on its own schedule,
 * and a row read a minute before that job would otherwise report the wrong thing.
 *
 *   overdue   the paid period is gone: expired, or grace already run out
 *   grace     ended, still inside the grace window
 *   due_soon  still active, ending within DUES_SOON_DAYS
 *   paused    a paused enrolment — surfaced, but never counted as chaseable
 *
 * `ok` rows are dropped: this list exists to be acted on, and an academy with 300 students
 * should not have to page through 280 of them who owe nothing.
 */
export async function getDues(scope: BatchScope, state?: string, batchId?: string) {
  const { DUES_SOON_DAYS } = await import('../../config.js');
  const rows = await repo.getDues(scope);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const items = rows
    .map((e) => {
      const period = e.periods[0];
      const paused = !!e.pausedUntil && e.pausedUntil.getTime() > now;
      const dueAt = period?.endDate ?? null;
      const daysLeft = dueAt ? Math.ceil((dueAt.getTime() - now) / DAY) : null;

      let dueState: 'overdue' | 'grace' | 'due_soon' | 'paused' | 'ok';
      if (paused) dueState = 'paused';
      else if (!period || period.status === 'expired') dueState = 'overdue';
      else if (period.status === 'grace') {
        dueState =
          period.gracePeriodEnd && period.gracePeriodEnd.getTime() < now ? 'overdue' : 'grace';
      } else if (period.status === 'cancelled') dueState = 'ok';
      else dueState = daysLeft !== null && daysLeft <= DUES_SOON_DAYS ? 'due_soon' : 'ok';

      return {
        enrollment_id: e.id,
        student: { id: e.learnerId, user_id: e.user.id, ...studentCard(e.user, e.learner) },
        batch: { id: e.batch.id, title: e.batch.title },
        state: dueState,
        due_at: dueAt?.toISOString() ?? null,
        days_left: daysLeft,
        grace_ends_at: period?.gracePeriodEnd?.toISOString() ?? null,
        // The period's own amount, not the batch's current monthly fee: a fee rise must not
        // retroactively change what an unrenewed period says is owed.
        amount_paise: period?.amountPaise ?? e.batch.monthlyFeePaise,
        package_type: period?.packageType ?? e.defaultPackage ?? null,
        payment_status: period?.payment?.status ?? null,
        // So an owner does not chase someone the app messaged an hour ago.
        last_reminder_at: period?.lastReminderSentAt?.toISOString() ?? null,
        reminders_sent: period?.remindersSentCount ?? 0,
      };
    })
    .filter((r) => r.state !== 'ok')
    .filter((r) => (batchId ? r.batch.id === batchId : true))
    .sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));

  const counts = {
    overdue: items.filter((i) => i.state === 'overdue').length,
    grace: items.filter((i) => i.state === 'grace').length,
    due_soon: items.filter((i) => i.state === 'due_soon').length,
    paused: items.filter((i) => i.state === 'paused').length,
  };

  return { items: state ? items.filter((i) => i.state === state) : items, counts };
}
