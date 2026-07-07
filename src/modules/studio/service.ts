import { AppError } from '../../lib/app-error.js';
import { toWireMode, toDbMode } from '../../lib/mode.js';
import { attendancePct, expectedSessions, tierOf } from '../../lib/attendance-tier.js';
import * as coachRepo from '../coaches/repo.js';
import * as repo from './repo.js';

export async function getDashboard(academyId: string) {
  return repo.getDashboardStats(academyId);
}

export async function getInbox(academyId: string, status?: string) {
  const { items, counts } = await repo.getInboxItems(academyId, status);
  return {
    items: items.map((t) => ({
      id: t.id,
      student_name: t.user.name,
      student_age: t.user.age,
      batch_title: t.batch.title,
      scheduled_at: t.trialAt.toISOString(),
      status: t.status,
      student_phone: t.user.phone,
      level: t.batch.level,
      category: t.batch.category,
      coach_name: t.batch.coach?.name,
      trial_fee_paise: t.batch.trialFeePaise,
    })),
    counts,
    next_cursor: null,
  };
}

export async function getActivity(academyId: string) {
  const { attendedTrials, reviews, enrollments, workshopRegs } = await repo.getActivity(academyId);
  const items = [
    ...attendedTrials.map((t) => ({
      id: `trial_${t.id}`,
      kind: 'trial_done' as const,
      icon_tone: 'jade' as const,
      title: `${t.user.name} completed a trial`,
      subtitle: t.batch.title,
      at: (t.attendanceMarkedAt ?? t.trialAt).toISOString(),
      action: { label: 'Invite to enroll', route: `/students/${t.userId}` },
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
      title: `${e.user.name} enrolled`,
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

export async function getTrialDetail(trialId: string, academyId: string) {
  const trial = await repo.getTrialDetail(trialId, academyId);
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
      batch_level: trial.batch.level,
      category: trial.batch.category,
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
      id: trial.user.id,
      name: trial.user.name,
      phone: trial.user.phone,
      age: trial.user.age,
      location: trial.user.location ?? undefined,
    },
  };
}

export async function getSchedule(academyId: string, weekStart?: string) {
  const start = weekStart ? new Date(weekStart) : new Date();
  const days = await repo.getSchedule(academyId, start);
  return { days };
}

export async function getBatches(academyId: string) {
  const batches = await repo.getBatches(academyId);
  return {
    items: batches.map((b) => ({
      id: b.id,
      title: b.title,
      category: b.category,
      level: b.level,
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

export async function getBatch(id: string, academyId: string) {
  const batch = await repo.getBatchById(id, academyId);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  return {
    batch: {
      id: batch.id,
      title: batch.title,
      category: batch.category,
      level: batch.level,
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
    level: string;
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
  // Every batch is created under a program. Identity/marketing fields (title, category,
  // description, things_to_know) are owned by the program and denormalized onto the batch.
  const program = await repo.getProgramById(data.program_id, academyId);
  if (!program) throw new AppError('NOT_FOUND', 404, 'Program not found in this academy');

  // A batch may only be assigned a coach that belongs to this academy.
  const owns = await coachRepo.coachBelongsToAcademy(data.coach_id, academyId);
  if (!owns) throw new AppError('NOT_FOUND', 404, 'Coach not found in this academy');

  const batch = await repo.createBatch({
    academyId,
    programId: program.id,
    coachId: data.coach_id,
    title: `${program.title} · ${data.level}`,
    category: program.category,
    level: data.level,
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
    level?: string;
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
    // S4.2: a batch may only be assigned a coach that belongs to this academy.
    const owns = await coachRepo.coachBelongsToAcademy(data.coach_id, academyId);
    if (!owns) throw new AppError('NOT_FOUND', 404, 'Coach not found in this academy');
    prismaData.coachId = data.coach_id;
  }
  if (data.title !== undefined) prismaData.title = data.title;
  if (data.category !== undefined) prismaData.category = data.category;
  if (data.level !== undefined) prismaData.level = data.level;
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
    level: b.level,
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

export async function getPrograms(academyId: string) {
  const programs = await repo.getPrograms(academyId);
  return {
    items: programs.map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      description: p.description ?? null,
      things_to_know: p.thingsToKnow ?? [],
      batch_count: p._count.batches,
      cover_url: (p as any).media?.[0]?.url ?? null,
      created_at: p.createdAt.toISOString(),
    })),
  };
}

export async function getProgramDetail(id: string, academyId: string) {
  const program = await repo.getProgramById(id, academyId);
  if (!program) throw new AppError('NOT_FOUND', 404, 'Program not found');
  return {
    program: {
      id: program.id,
      title: program.title,
      category: program.category,
      description: program.description ?? null,
      things_to_know: program.thingsToKnow ?? [],
      media: (program as any).media?.map((m: any) => ({ url: m.url, type: m.type })) ?? [],
      created_at: program.createdAt.toISOString(),
    },
    batches: program.batches.map(toStudioBatch),
  };
}

export async function createProgram(
  academyId: string,
  data: { title: string; category: string; description?: string; things_to_know?: string[]; media?: { url: string; type: string }[] },
) {
  const program = await repo.createProgram({
    academyId,
    title: data.title,
    category: data.category,
    description: data.description,
    thingsToKnow: data.things_to_know,
    media: data.media,
  });
  return { program: { id: program.id } };
}

export async function updateProgram(
  id: string,
  academyId: string,
  data: { title?: string; description?: string; things_to_know?: string[]; media?: { url: string; type: string }[] },
) {
  const prismaData: Record<string, unknown> = {};
  if (data.title !== undefined) prismaData.title = data.title;
  if (data.description !== undefined) prismaData.description = data.description;
  if (data.things_to_know !== undefined) prismaData.thingsToKnow = data.things_to_know;
  await repo.updateProgram(id, academyId, prismaData, data.media);
  return { program: { id } };
}

export async function deleteProgram(id: string, academyId: string) {
  // A program is deletable only when it has no batches (plan §8 — retire by stopping batches first).
  const count = await repo.countProgramBatches(id);
  if (count > 0) {
    throw new AppError('CONFLICT', 409, 'Delete or discontinue this program’s batches first');
  }
  await repo.deleteProgram(id, academyId);
  return {};
}

export async function getStudents(
  academyId: string,
  q?: string,
  batchId?: string,
  attendanceTier?: 'active' | 'irregular' | 'inactive',
) {
  const enrollments = await repo.getStudents(academyId, q, 20, batchId, attendanceTier);
  const userMap = new Map();
  for (const e of enrollments) {
    if (!userMap.has(e.userId)) {
      userMap.set(e.userId, {
        id: e.userId,
        name: e.user.name,
        phone: e.user.phone,
        age: e.user.age,
        batches: [],
        // S4.1: % + tier for the (filtered) batch — the first enrolment row carries it.
        attendance_pct: e.attendance_pct,
        tier: e.tier,
        status: 'active',
      });
    }
    userMap.get(e.userId).batches.push({ title: e.batch.title, category: e.batch.category });
  }
  return { items: Array.from(userMap.values()), next_cursor: null };
}

export async function getStudent(userId: string, academyId: string) {
  const { user, enrollments, attendance, trials } = await repo.getStudentById(userId, academyId);
  if (!user) throw new AppError('NOT_FOUND', 404, 'Student not found');

  // S4.1: overall tier across the student's active enrolments (present / expected).
  const now = new Date();
  let totalPresent = 0;
  let totalExpected = 0;
  for (const e of enrollments) {
    if (e.status !== 'active') continue;
    totalPresent += attendance.filter((a) => a.batchId === e.batchId && a.present).length;
    totalExpected += expectedSessions(e.batch.sessionsPerMonth, e.startedAt, now);
  }
  const overallPct = attendancePct(totalPresent, totalExpected);

  return {
    student: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      age: user.age,
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

export async function getBatchStudents(batchId: string, academyId: string) {
  const students = await repo.getBatchStudents(batchId, academyId);
  return { students };
}

export async function getReviews(
  academyId: string,
  filter?: 'all' | 'needs_reply' | 'replied' | '5' | 'lte3',
) {
  const [reviews, summary] = await Promise.all([
    repo.getReviews(academyId, filter),
    repo.getReviewsSummary(academyId),
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

export async function getReviewsSummary(academyId: string) {
  return repo.getReviewsSummary(academyId);
}

export async function respondToReview(id: string, academyId: string, response: string) {
  await repo.respondToReview(id, academyId, response);
  return { review: { id } };
}

export async function getEarnings(academyId: string, opts: repo.EarningsOpts = {}) {
  const earnings = await repo.getEarnings(academyId, opts);
  // S7: settlement — rolling reserve + recovery owed, and net payable after netting.
  const { getSettlement } = await import('../settlement/service.js');
  const settlement = await getSettlement(academyId);
  const netPayable = Math.max(0, (earnings.net_paise ?? 0) - settlement.outstanding_recovery_paise);
  return { ...earnings, settlement, net_payable_paise: netPayable };
}

type NotificationChannelPrefs = { push: boolean; email: boolean; whatsapp: boolean };
type GranularNotifications = {
  new_trial: NotificationChannelPrefs;
  classes: { reminder_30min: boolean; attendance_reminder: boolean };
  reviews_activity: { new_review: boolean; leaderboard: boolean; reels: boolean };
  quiet_hours: { enabled: boolean; start: string; end: string };
};

function defaultNotifications(newTrial: boolean, review: boolean): GranularNotifications {
  return {
    new_trial: { push: newTrial, email: false, whatsapp: false },
    classes: { reminder_30min: true, attendance_reminder: true },
    reviews_activity: { new_review: review, leaderboard: false, reels: false },
    quiet_hours: { enabled: false, start: '22:00', end: '07:00' },
  };
}

export async function getSettings(accountId: string) {
  const settings = await repo.getSettings(accountId);
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
    privacy: { show_phone: settings?.privacyShowPhone ?? false },
    contact: {
      email: settings?.contactEmail ?? undefined,
      whatsapp: settings?.contactWhatsapp ?? undefined,
    },
  };
}

export async function updateSettings(
  accountId: string,
  data: {
    notifications?: {
      new_trial?: Partial<NotificationChannelPrefs>;
      classes?: Partial<{ reminder_30min: boolean; attendance_reminder: boolean }>;
      reviews_activity?: Partial<{ new_review: boolean; leaderboard: boolean; reels: boolean }>;
      quiet_hours?: Partial<{ enabled: boolean; start: string; end: string }>;
    };
    privacy?: { show_phone?: boolean };
    contact?: { email?: string; whatsapp?: string };
  },
) {
  const current = await getSettings(accountId);
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
  if (data.privacy?.show_phone !== undefined) prismaData.privacyShowPhone = data.privacy.show_phone;
  if (data.contact?.email !== undefined) prismaData.contactEmail = data.contact.email;
  if (data.contact?.whatsapp !== undefined) prismaData.contactWhatsapp = data.contact.whatsapp;

  await repo.upsertSettings(accountId, prismaData);
  return { settings: await getSettings(accountId) };
}

export async function getAcademy(academyId: string) {
  const academy = await repo.getAcademyById(academyId);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  return {
    academy: {
      id: academy.id,
      name: academy.name,
      category: academy.category,
      address: academy.address,
      lat: academy.lat,
      lng: academy.lng,
      rating: academy.rating,
      rating_count: academy.ratingCount,
      verified: academy.verified,
      bio: academy.bio,
      tagline: academy.tagline,
      modes_offered: academy.modesOffered,
      specialities: academy.specialities,
      images: academy.images,
      bank_account_number: academy.bankAccountNumber,
      bank_ifsc: academy.bankIfsc,
      bank_holder_name: academy.bankHolderName,
    },
  };
}

export async function updateAcademy(academyId: string, data: {
  name?: string;
  category?: string;
  address?: string;
  bio?: string;
  tagline?: string;
  specialities?: string[];
  lat?: number;
  lng?: number;
  bank_account_number?: string;
  bank_ifsc?: string;
  bank_holder_name?: string;
  images?: string[];
}) {
  const prismaData: Record<string, unknown> = {};
  if (data.name !== undefined) prismaData.name = data.name;
  if (data.category !== undefined) prismaData.category = data.category;
  if (data.address !== undefined) prismaData.address = data.address;
  if (data.bio !== undefined) prismaData.bio = data.bio;
  if (data.tagline !== undefined) prismaData.tagline = data.tagline;
  if (data.specialities !== undefined) prismaData.specialities = data.specialities;
  if (data.lat !== undefined) prismaData.lat = data.lat;
  if (data.lng !== undefined) prismaData.lng = data.lng;
  if (data.bank_account_number !== undefined) prismaData.bankAccountNumber = data.bank_account_number;
  if (data.bank_ifsc !== undefined) prismaData.bankIfsc = data.bank_ifsc;
  if (data.bank_holder_name !== undefined) prismaData.bankHolderName = data.bank_holder_name;
  if (data.images !== undefined) prismaData.images = data.images;
  await repo.updateAcademy(academyId, prismaData);
  return await getAcademy(academyId);
}
