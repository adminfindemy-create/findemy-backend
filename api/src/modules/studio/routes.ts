import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BatchTimingInput } from '@findemy/types';
import * as service from './service.js';
import * as uploadService from './upload.js';
import { getSession } from './session.js';
import { getAuditLog } from './audit.js';
import { getMyTeachingProfile, updateMyTeachingProfile } from './teaching-profile.js';
import { getMyAccount, updateMyAccount } from './my-account.js';
import { AppError } from '../../lib/app-error.js';
import { kycKeyPrefix, isKycKeyOwnedBy } from '../../lib/kyc-files.js';
import { batchScope, isAssignedScope } from '../../lib/scope.js';
import { writeStaffAudit } from '../../lib/audit-actor.js';

// A batch's age range must not be inverted. Either bound may be null (open-ended).
const AGE_RANGE_ERROR = { message: 'max_age must be greater than or equal to min_age', path: ['max_age'] };
const ageRangeOrdered = (v: { min_age?: number | null; max_age?: number | null }) =>
  v.min_age == null || v.max_age == null || v.max_age >= v.min_age;

// The caller's own account: only the name. The login phone needs OTP verification of the new
// number, and role/branches are access — the owner's to grant, not the holder's to change.
const MyAccountSchema = z.object({ name: z.string().min(1) }).strict();

// What a teacher may change about how they appear to students. `name` is included: they are the
// person, and an owner's typo in a student-facing name should be theirs to fix.
const TeachingProfileSchema = z.object({
  name: z.string().min(1).optional(),
  specialty: z.string().min(1).optional(),
  bio: z.string().optional(),
  credentials: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
}).strict();

const BatchCreateSchema = z.object({
  // Every batch is created under a program (no standalone batch creation). Title/category/
  // description/things_to_know are owned by the program and derived server-side.
  program_id: z.string().min(1),
  coach_id: z.string().min(1),
  // Academy-authored label distinguishing sibling batches ("Weekday Evening"). `level` now
  // lives on the program. See ai-usage/final-app/plan/batch-attributes-and-level-move.md.
  name: z.string().min(1),
  // Target age range. Omit both for "all ages"; omit max_age for open-ended ("6+").
  min_age: z.number().int().min(0).max(120).nullish(),
  max_age: z.number().int().min(0).max(120).nullish(),
  // Orthogonal to `mode` — a 1-on-1 can be online or in-studio.
  session_format: z.enum(['group', 'one_on_one']).optional(),
  gender: z.enum(['anyone', 'female_only']).optional(),
  capacity: z.number().int().min(1),
  trial_fee_paise: z.number().int().min(0),
  monthly_fee_paise: z.number().int().min(0),
  // S1.3: academy-set discounts in bps, capped at 3000 (30%).
  quarterly_discount_bps: z.number().int().min(0).max(3000).optional(),
  annual_discount_bps: z.number().int().min(0).max(3000).optional(),
  // S3.4: number of classes per month (the explicit entitled count).
  sessions_per_month: z.number().int().min(1).max(31).optional(),
  // S1.3: canonical Mode wire vocabulary ('in-studio' | 'online'); mapped to DB online|offline.
  mode: z.enum(['in-studio', 'online']).optional(),
  timings: z.array(BatchTimingInput).optional(),
}).refine(ageRangeOrdered, AGE_RANGE_ERROR);

const MediaItem = z.object({ url: z.string().min(1), type: z.enum(['photo', 'video']) });

const ProgramCreateSchema = z.object({
  title: z.string().min(1),
  category: z.enum(['music', 'dance', 'arts', 'yoga']),
  // Difficulty of the offering — moved up from Batch.
  level: z.string().min(1),
  description: z.string().min(1),
  things_to_know: z.array(z.string()).optional(),
  // At least 3 photos/videos (max 10 combined).
  media: z.array(MediaItem).min(3, 'Add at least 3 photos or videos').max(10, 'Up to 10 media items'),
});

const ProgramUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  level: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  things_to_know: z.array(z.string()).optional(),
  // If provided, replaces the program's media (min 3, max 10).
  media: z.array(MediaItem).min(3).max(10).optional(),
}).strict();

const ReviewRespondSchema = z.object({
  response: z.string().min(1),
});

// BRANCH identity and policy only. The KYC/bank fields this used to accept moved to
// FinancialEntitySchema below: they belong to the payee, several branches can share one, and
// editing them from a branch screen silently rewrote a sibling branch's bank account.
// `.strict()` turns a client that still sends them into a 400 rather than a silent no-op.
// The BRAND, not a branch. Only the name for now: `AcademyGroup` also carries bio/tagline/
// category, but every one of those is duplicated per branch (createBranch seeds them from the
// primary branch and they stay editable there), so making the group copy writable too would
// give a learner two sources for the same sentence. `.strict()` so that stays deliberate.
const GroupUpdateSchema = z
  .object({ name: z.string().min(1).max(120) })
  .strict();

const AcademyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  branch_label: z.string().min(1).max(80).optional(),
  // The PRIMARY art form — cover art, discovery badge, ordering.
  category: z.enum(['music', 'dance', 'arts', 'yoga']).optional(),
  // Everything this branch teaches. A studio running music and dance is findable under
  // both; the primary is always folded in server-side so the two can never disagree.
  categories: z.array(z.enum(['music', 'dance', 'arts', 'yoga'])).max(4).optional(),
  address: z.string().optional(),
  bio: z.string().optional(),
  tagline: z.string().optional(),
  specialities: z.array(z.string()).optional(),
  // Catalogue keys OR an academy's own wording. The column is a plain String[], and both
  // apps already render an unknown key (amenityLabel() falls back to the key text,
  // AmenityIcon to a generic glyph), so the enum was the only thing forbidding
  // "Instrument rental" or "Parking for two-wheelers". Bounded so it stays a chip.
  amenities: z
    .array(z.string().trim().min(1).max(40))
    .max(30)
    .optional(),
  // How the branch teaches. Collected at onboarding and, since students now read it off the
  // academy page, editable here too — an academy that adds home visits a month after signing up
  // had no way to say so.
  modes_offered: z.array(z.enum(['in_studio', 'online', 'home_visit'])).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  images: z.array(z.string()).optional(),
}).strict();

// A new branch. Address + map pin is the only genuinely new required data — coaches and
// programs are brand-level, so the moment this returns the owner can open "Add batch" and
// pick an existing program and coach (plan §7).
const BranchCreateSchema = z.object({
  branch_label: z.string().min(1).max(80),
  address: z.string().min(1),
  lat: z.number().optional(),
  lng: z.number().optional(),
  category: z.enum(['music', 'dance', 'arts', 'yoga']).optional(),
  images: z.array(z.string()).optional(),
  // Reuse the brand's existing payee (no duplicate KYC), or start a new one. Omitted → the
  // group's only entity when there is exactly one.
  financial_entity_id: z.string().min(1).optional(),
  create_financial_entity: z.boolean().optional(),
  financial_entity_label: z.string().min(1).max(120).optional(),
}).strict();

// The payee. Group-scoped on purpose: this is the ONLY way to write bank/KYC details, and a
// client is expected to warn that the edit affects every branch behind the entity.
const FinancialEntitySchema = z.object({
  label: z.string().min(1).max(120).optional(),
  bank_account_number: z.string().optional(),
  bank_ifsc: z.string().optional(),
  bank_holder_name: z.string().optional(),
  pan_number: z.string().max(20).optional(),
  pan_image_url: z.string().min(1).optional(),
  aadhaar_last4: z.string().regex(/^\d{4}$/, 'Enter the last 4 digits').optional().or(z.literal('')),
  aadhaar_image_url: z.string().min(1).optional(),
  business_doc_urls: z.array(z.string().min(1)).optional(),
  // One entity can hold a Delhi AND a Haryana GSTIN — hence a list, not a column.
  gst_registrations: z
    .array(z.object({ gst_number: z.string().min(1).max(20), state: z.string().max(60).optional() }))
    .optional(),
}).strict();

const BatchUpdateSchema = z.object({
  coach_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  category: z.enum(['music', 'dance', 'arts', 'yoga']).optional(),
  name: z.string().min(1).optional(),
  min_age: z.number().int().min(0).max(120).nullish(),
  max_age: z.number().int().min(0).max(120).nullish(),
  session_format: z.enum(['group', 'one_on_one']).optional(),
  gender: z.enum(['anyone', 'female_only']).optional(),
  description: z.string().optional(),
  things_to_know: z.array(z.string()).optional(),
  capacity: z.number().int().min(1).optional(),
  trial_fee_paise: z.number().int().min(0).optional(),
  monthly_fee_paise: z.number().int().min(0).optional(),
  quarterly_discount_bps: z.number().int().min(0).max(3000).optional(),
  annual_discount_bps: z.number().int().min(0).max(3000).optional(),
  sessions_per_month: z.number().int().min(1).max(31).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  mode: z.enum(['in-studio', 'online']).optional(),
  timings: z.array(BatchTimingInput).optional(),
}).strict().refine(ageRangeOrdered, AGE_RANGE_ERROR);

const ChannelPrefs = z.object({
  push: z.boolean().optional(),
  email: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
});
const SettingsUpdateSchema = z.object({
  notifications: z.object({
    new_trial: ChannelPrefs.optional(),
    classes: z.object({
      reminder_30min: z.boolean().optional(),
      attendance_reminder: z.boolean().optional(),
    }).optional(),
    reviews_activity: z.object({
      new_review: z.boolean().optional(),
    }).optional(),
    quiet_hours: z.object({
      enabled: z.boolean().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
    }).optional(),
  }).optional(),
  privacy: z.object({
    show_phone: z.boolean().optional(),
  }).optional(),
  contact: z.object({
    email: z.string().optional(),
    whatsapp: z.string().optional(),
  }).optional(),
}).strict();

export const studioRoutes: FastifyPluginAsync = async (app) => {
  app.get('/studio/dashboard', { preHandler: app.requireAuth('academy', 'dashboard.view') }, async (req) => {
    return service.getDashboard(
      batchScope(req.user, 'dashboard.view'),
      req.user.perms_map?.has('earnings.view') ?? false,
    );
  });

  app.get('/studio/academy', { preHandler: app.requireAuth('academy', 'academy.view') }, async (req) => {
    return service.getAcademy(req.user.academy_id!);
  });

  app.put('/studio/academy', { preHandler: app.requireAuth('academy', 'academy.edit') }, async (req) => {
    const body = AcademyUpdateSchema.parse(req.body);
    return service.updateAcademy(req.user.academy_id!, body);
  });

  // Who am I and what may I do. The client renders its navigation from this rather than from a
  // role name, so a custom role needs no client change. No permission key: every academy-side
  // principal may ask what it is.
  app.get('/studio/session', { preHandler: app.requireAuth('academy') }, async (req) => {
    return getSession(req);
  });

  // The caller's OWN account — name, login phone, and what they have access to. Every
  // academy-side role has one, which is the point: before this a manager could sign in and find
  // nothing in the app that said who they were.
  app.get('/studio/me/account', { preHandler: app.requireAuth('academy') }, async (req) => {
    return getMyAccount(req);
  });

  app.put('/studio/me/account', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = MyAccountSchema.parse(req.body);
    const result = await updateMyAccount(req, body.name);
    await writeStaffAudit(req, {
      action: 'account.rename',
      targetType: req.user.sub_kind === 'staff' ? 'StaffAccount' : 'AcademyAccount',
      targetId: req.user.id,
      after: { name: body.name },
    });
    return result;
  });

  // The caller's OWN teaching profile. No permission key: it resolves the coach from
  // `req.user.coach_ids`, so there is no other person's row it could reach. An owner or manager
  // has no teaching profile and gets a 404, not a 403.
  app.get('/studio/me/teaching-profile', { preHandler: app.requireAuth('academy') }, async (req) => {
    return getMyTeachingProfile(req);
  });

  app.put('/studio/me/teaching-profile', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = TeachingProfileSchema.parse(req.body);
    const result = await updateMyTeachingProfile(req, body);
    await writeStaffAudit(req, {
      action: 'teachingProfile.update',
      targetType: 'Coach',
      targetId: result.profile.id,
      after: body,
    });
    return result;
  });

  // Owner-only record of who did what. NOT merged into /studio/activity, which is a
  // student-event feed — see modules/studio/audit.ts.
  app.get('/studio/audit', { preHandler: app.requireAuth('academy', 'audit.view') }, async (req) => {
    const { cursor } = req.query as { cursor?: string };
    return getAuditLog(req.user.group_id!, cursor);
  });

  // --- Branches (the brand's locations) ---
  //
  // Group-scoped, deliberately: this is the branch switcher's data source, so it must list
  // every location regardless of which one `X-Branch-Id` currently points at.
  app.get('/studio/branches', { preHandler: app.requireAuth('academy', 'branches.view') }, async (req) => {
    return service.getBranches(req.user.group_id!, req.user.academy_id, req.user.allowed_branch_ids);
  });

  app.post('/studio/branches', { preHandler: app.requireAuth('academy', 'branches.create') }, async (req) => {
    const body = BranchCreateSchema.parse(req.body);
    const result = await service.createBranch(req.user.group_id!, body);
    await writeStaffAudit(req, {
      action: 'branch.create', targetType: 'Academy',
      targetId: (result as { branch?: { id?: string } }).branch?.id ?? '',
      after: body,
    });
    return result;
  });

  // Set the branch this login lands on when it sends no `X-Branch-Id`.
  app.put('/studio/branches/:id/default', { preHandler: app.requireAuth('academy', 'branches.setDefault') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.setDefaultBranch(req.user.id, req.user.group_id!, id);
  });

  // --- The brand ---

  // Group-scoped, and owner-only via `settings.brand.edit` — the key that already denies a
  // manager the bank details and branch creation. A rename reaches every branch and everything
  // a learner sees in search, which is the same blast radius.
  app.put('/studio/group', { preHandler: app.requireAuth('academy', 'settings.brand.edit') }, async (req) => {
    const body = GroupUpdateSchema.parse(req.body);
    const before = await service.getGroupForAudit(req.user.group_id!);
    const result = await service.updateGroup(req.user.group_id!, body);
    await writeStaffAudit(req, {
      action: 'group.rename',
      targetType: 'AcademyGroup',
      targetId: req.user.group_id!,
      before,
      after: { name: result.group.name },
      extra: { branches_renamed: result.branches_renamed },
    });
    return result;
  });

  // --- Financial entities (the payee) ---

  app.get('/studio/financial-entities', { preHandler: app.requireAuth('academy', 'finance.kyc') }, async (req) => {
    return service.getFinancialEntities(req.user.group_id!);
  });

  app.put('/studio/financial-entities/:id', { preHandler: app.requireAuth('academy', 'finance.kyc') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = FinancialEntitySchema.parse(req.body);
    const keys = [body.pan_image_url, body.aadhaar_image_url, ...(body.business_doc_urls ?? [])];
    if (keys.some((k) => k !== undefined && !isKycKeyOwnedBy(k, req.user.group_id!))) {
      throw new AppError('VALIDATION', 400, 'Invalid KYC document reference — upload the file again');
    }
    return service.updateFinancialEntity(req.user.group_id!, id, body);
  });

  app.get('/studio/batches', { preHandler: app.requireAuth('academy', 'batches.view') }, async (req) => {
    return service.getBatches(batchScope(req.user, 'batches.view'));
  });

  app.get('/studio/batches/:id', { preHandler: app.requireAuth('academy', 'batches.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBatch(id, batchScope(req.user, 'batches.view'));
  });

  app.post('/studio/batches', { preHandler: app.requireAuth('academy', 'batches.manage') }, async (req) => {
    const body = BatchCreateSchema.parse(req.body);
    const result = await service.createBatch(req.user.academy_id!, body);
    await writeStaffAudit(req, {
      action: 'batch.create', targetType: 'Batch',
      targetId: (result as { batch?: { id?: string } }).batch?.id ?? '',
      after: body,
    });
    return result;
  });

  app.put('/studio/batches/:id', { preHandler: app.requireAuth('academy', 'batches.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = BatchUpdateSchema.parse(req.body);
    const before = await service.getBatch(id, batchScope(req.user, 'batches.manage'));
    const result = await service.updateBatch(id, req.user.academy_id!, body);
    await writeStaffAudit(req, {
      action: 'batch.update', targetType: 'Batch', targetId: id, before, after: body,
    });
    return result;
  });

  app.delete('/studio/batches/:id', { preHandler: app.requireAuth('academy', 'batches.delete') }, async (req) => {
    const { id } = req.params as { id: string };
    const before = await service.getBatch(id, batchScope(req.user, 'batches.delete'));
    const result = await service.deleteBatch(id, req.user.academy_id!);
    await writeStaffAudit(req, {
      action: 'batch.delete', targetType: 'Batch', targetId: id, before,
    });
    return result;
  });

  app.get('/studio/batches/:id/students', { preHandler: app.requireAuth('academy', 'batches.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBatchStudents(id, batchScope(req.user, 'batches.view'));
  });

  // --- Program media upload (photos/videos) ---
  app.post('/studio/media/upload', { preHandler: app.requireAuth('academy', 'media.upload') }, async (req) => {
    const data = await req.file();
    if (!data) throw new Error('No file uploaded');
    const buffer = await data.toBuffer();
    const { storeMedia } = await import('../../lib/media-storage.js');
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    return storeMedia({ keyPrefix: `programs/${req.user.group_id!}`, buffer, mimeType: data.mimetype, baseUrl });
  });

  // #3: KYC document upload (PAN/Aadhaar/GST/business). Stored in the PRIVATE bucket; returns
  // { url } — an opaque storage key to save on the financial entity. Reads come back as
  // short-lived presigned URLs, never a public link.
  app.post('/studio/kyc/upload', { preHandler: app.requireAuth('academy', 'finance.kyc') }, async (req) => {
    const data = await req.file();
    if (!data) throw new Error('No file uploaded');
    const buffer = await data.toBuffer();
    const { storePrivateFile } = await import('../../lib/media-storage.js');
    // Keyed by the BRAND: KYC documents belong to a financial entity, never to a location.
    const { storageKey } = await storePrivateFile({
      keyPrefix: kycKeyPrefix(req.user.group_id!),
      buffer,
      mimeType: data.mimetype,
    });
    return { url: storageKey };
  });

  // --- Programs ---
  app.get('/studio/programs', { preHandler: app.requireAuth('academy', 'programs.view') }, async (req) => {
    return service.getPrograms(req.user.group_id!, req.user.academy_id, req.user.allowed_branch_ids);
  });

  app.get('/studio/programs/:id', { preHandler: app.requireAuth('academy', 'programs.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getProgramDetail(id, req.user.group_id!, req.user.academy_id);
  });

  // Three keys, not one: create and edit are a manager's, delete is the owner's. The line is
  // reversibility — a delete takes the program's batches with it. See lib/permissions.ts.
  app.post('/studio/programs', { preHandler: app.requireAuth('academy', 'programs.create') }, async (req) => {
    const body = ProgramCreateSchema.parse(req.body);
    const result = await service.createProgram(req.user.group_id!, body);
    await writeStaffAudit(req, {
      action: 'program.create', targetType: 'Program',
      targetId: (result as { program?: { id?: string } }).program?.id ?? '',
      after: body,
    });
    return result;
  });

  app.put('/studio/programs/:id', { preHandler: app.requireAuth('academy', 'programs.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ProgramUpdateSchema.parse(req.body);
    const result = await service.updateProgram(id, req.user.group_id!, body);
    await writeStaffAudit(req, {
      action: 'program.update', targetType: 'Program', targetId: id, after: body,
    });
    return result;
  });

  app.delete('/studio/programs/:id', { preHandler: app.requireAuth('academy', 'programs.delete') }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await service.deleteProgram(id, req.user.group_id!);
    await writeStaffAudit(req, { action: 'program.delete', targetType: 'Program', targetId: id });
    return result;
  });

  app.get('/studio/schedule', { preHandler: app.requireAuth('academy', 'schedule.view') }, async (req) => {
    const { week_start } = req.query as { week_start?: string };
    return service.getSchedule(batchScope(req.user, 'schedule.view'), week_start);
  });

  app.get('/studio/inbox', { preHandler: app.requireAuth('academy', 'inbox.view') }, async (req) => {
    const { status } = req.query as { status?: string };
    // `scope` is passed only when this subject is limited to its own batches; an owner or
    // manager keeps the wider read.
    const scope = batchScope(req.user, 'inbox.view');
    return service.getInbox(
      req.user.group_id!,
      status,
      req.user.allowed_branch_ids,
      isAssignedScope(scope) ? scope : undefined,
    );
  });

  app.get('/studio/trials/:id', { preHandler: app.requireAuth('academy', 'trials.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getTrialDetail(id, batchScope(req.user, 'trials.view'));
  });

  app.get('/studio/activity', { preHandler: app.requireAuth('academy', 'inbox.view') }, async (req) => {
    return service.getActivity(batchScope(req.user, 'inbox.view'));
  });

  // Fees due. Gated on `enrollments.manage` — owner and manager, never a teacher: chasing a
  // renewal is running the academy day to day, and a teacher sees no pricing anywhere else.
  app.get('/studio/dues', { preHandler: app.requireAuth('academy', 'enrollments.manage') }, async (req) => {
    const { state, batch_id } = req.query as { state?: string; batch_id?: string };
    return service.getDues(batchScope(req.user, 'enrollments.manage'), state, batch_id);
  });

  app.get('/studio/students', { preHandler: app.requireAuth('academy', 'students.view') }, async (req) => {
    const { q, batch_id, attendance_tier } = req.query as { q?: string; batch_id?: string; attendance_tier?: 'active' | 'irregular' | 'inactive' };
    return service.getStudents(batchScope(req.user, 'students.view'), q, batch_id, attendance_tier);
  });

  app.get('/studio/students/:id', { preHandler: app.requireAuth('academy', 'students.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getStudent(id, batchScope(req.user, 'students.view'));
  });

  app.get('/studio/reviews', { preHandler: app.requireAuth('academy', 'reviews.view') }, async (req) => {
    const { filter } = req.query as { filter?: 'all' | 'needs_reply' | 'replied' | '5' | 'lte3' };
    return service.getReviews(batchScope(req.user, 'reviews.view'), filter);
  });

  app.get('/studio/reviews/summary', { preHandler: app.requireAuth('academy', 'reviews.view') }, async (req) => {
    return service.getReviewsSummary(batchScope(req.user, 'reviews.view'));
  });

  app.post('/studio/reviews/:id/respond', { preHandler: app.requireAuth('academy', 'reviews.respond') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ReviewRespondSchema.parse(req.body);
    const result = await service.respondToReview(id, req.user.academy_id!, body.response);
    await writeStaffAudit(req, {
      action: 'review.respond', targetType: 'Review', targetId: id, after: { response: body.response },
    });
    return result;
  });

  app.get('/studio/earnings', { preHandler: app.requireAuth('academy', 'earnings.view') }, async (req) => {
    const q = req.query as {
      period?: 'week' | 'month' | 'year';
      from?: string;
      to?: string;
      category?: 'trial' | 'enrollment' | 'workshop';
    };
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    return service.getEarnings(req.user.academy_id!, {
      period: q.period,
      from: from && !isNaN(from.getTime()) ? from : undefined,
      to: to && !isNaN(to.getTime()) ? to : undefined,
      category: q.category,
    });
  });

  app.get('/studio/settings', { preHandler: app.requireAuth('academy', 'settings.view') }, async (req) => {
    return service.getSettings(req.user.id, req.user.group_id);
  });

  // ⚠️ The ONE handler mapping to TWO permission keys. Its body mixes a per-login fact
  // (notification preferences, which every role may change for themselves) with three BRAND
  // facts — public contact email, WhatsApp, and the show-phone flag — which are owner-only.
  // The guard checks the per-login key; the brand half is checked here, because it depends on
  // what the body actually contains.
  app.put('/studio/settings', { preHandler: app.requireAuth('academy', 'me.notifications.edit') }, async (req) => {
    const body = SettingsUpdateSchema.parse(req.body);
    if (service.touchesBrandSettings(body) && !req.user.perms_map?.has('settings.brand.edit')) {
      throw new AppError('FORBIDDEN', 403, 'Only the owner can change the academy’s contact details');
    }
    return service.updateSettings(req.user.id, req.user.group_id, body);
  });

  app.post('/studio/academy/upload', { preHandler: app.requireAuth('academy', 'academy.edit') }, async (req) => {
    const data = await req.file();
    if (!data) throw new Error('No file uploaded');
    const buffer = await data.toBuffer();
    const mimeType = data.mimetype;
    const imageUrl = await uploadService.uploadAcademyImage(req.user.academy_id!, buffer, mimeType);
    const result = await uploadService.addAcademyImage(req.user.academy_id!, imageUrl);
    return { url: imageUrl, images: result.images };
  });

  app.delete('/studio/academy/image', { preHandler: app.requireAuth('academy', 'academy.edit') }, async (req) => {
    const { url } = req.body as { url: string };
    if (!url) throw new Error('url required');
    const result = await uploadService.removeAcademyImage(req.user.academy_id!, url);
    return { images: result.images };
  });
};
