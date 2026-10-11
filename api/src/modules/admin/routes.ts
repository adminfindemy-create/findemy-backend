import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { rateLimit } from '../../lib/ratelimit.js';
import * as service from './service.js';
import * as adminRepo from './repo.js';
import * as support from './support.js';
import * as discontinuation from './discontinuation.js';
import * as analytics from './analytics.js';
import * as events from './events.js';
import * as moderation from './moderation.js';
import * as broadcast from './broadcast.js';

const PaymentTypeEnum = z.enum(['trial', 'workshop', 'event', 'enrollment']);

const GoogleLoginSchema = z.object({ idToken: z.string().min(1) });
const DevLoginSchema = z.object({ email: z.string().email() });
const CreateAdminSchema = z.object({ email: z.string().email(), name: z.string().min(1) });
const ReasonSchema = z.object({ reason: z.string().min(1).max(500) });
const AcademyStatusEnum = z.enum(['pending_review', 'approved', 'rejected', 'suspended']);

// Throttle admin auth attempts by client IP (the backend had no rate-limiting).
function throttleAuth(req: FastifyRequest) {
  const { allowed, retryAfterMs } = rateLimit(`admin-auth:${req.ip}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!allowed) {
    throw new AppError('RATE_LIMITED', 429, `Too many attempts, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
  }
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // ---------- Auth (unguarded, rate-limited) ----------
  app.post('/admin/auth/oauth/google', async (req) => {
    throttleAuth(req);
    const body = GoogleLoginSchema.parse(req.body);
    return service.adminLoginWithGoogle(body);
  });

  // MOCK-only dev login (service rejects unless MOCK=1).
  app.post('/admin/auth/dev-login', async (req) => {
    throttleAuth(req);
    const body = DevLoginSchema.parse(req.body);
    return service.adminDevLogin(body);
  });

  // ---------- Admin management ----------
  app.get('/admin/admins', { preHandler: app.requireAdmin('admins.read') }, async () => {
    return service.listAdmins();
  });

  app.post('/admin/admins', { preHandler: app.requireAdmin('admins.write') }, async (req) => {
    const body = CreateAdminSchema.parse(req.body);
    return service.createAdmin(req.user.adminId!, body);
  });

  app.post('/admin/admins/:id/disable', { preHandler: app.requireAdmin('admins.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.disableAdmin(req.user.adminId!, id);
  });

  // ---------- Academy verification ----------
  app.get('/admin/academies', { preHandler: app.requireAdmin('academies.read') }, async (req) => {
    const { status } = z.object({ status: AcademyStatusEnum.optional() }).parse(req.query);
    return service.listAcademies(status);
  });

  app.get('/admin/academies/:id', { preHandler: app.requireAdmin('academies.read') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.getAcademy(id);
  });

  app.post('/admin/academies/:id/approve', { preHandler: app.requireAdmin('academies.verify') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.approveAcademy(req.user.adminId!, id);
  });

  app.post('/admin/academies/:id/reject', { preHandler: app.requireAdmin('academies.verify') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { reason } = ReasonSchema.parse(req.body);
    return service.rejectAcademy(req.user.adminId!, id, reason);
  });

  // --- Entity KYC: the SECOND, independent verification queue (plan §9) ---
  //
  // Branch review (above) gates appearance in discovery; this gates payability. A new branch
  // that reuses an already-verified payee passes through branch review alone and never shows
  // up here, which is the entire point of splitting them.
  app.get('/admin/financial-entities', { preHandler: app.requireAdmin('academies.read') }, async (req) => {
    const { bank_kyc_status } = z
      .object({ bank_kyc_status: z.enum(['unverified', 'verified', 'failed']).optional() })
      .parse(req.query);
    return { items: await adminRepo.listFinancialEntities(bank_kyc_status) };
  });

  app.post('/admin/financial-entities/:id/verify-kyc', { preHandler: app.requireAdmin('academies.verify') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.verifyFinancialEntityKyc(req.user.adminId!, id);
  });

  app.post('/admin/financial-entities/:id/fail-kyc', { preHandler: app.requireAdmin('academies.verify') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    return service.failFinancialEntityKyc(req.user.adminId!, id, reason);
  });

  app.post('/admin/academies/:id/suspend', { preHandler: app.requireAdmin('academies.verify') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { reason } = ReasonSchema.parse(req.body);
    return service.suspendAcademy(req.user.adminId!, id, reason);
  });

  app.post('/admin/academies/:id/unsuspend', { preHandler: app.requireAdmin('academies.verify') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.unsuspendAcademy(req.user.adminId!, id);
  });

  // ---------- Support 360 ----------
  app.get('/admin/lookup', { preHandler: app.requireAdmin('support.read') }, async (req) => {
    const { q } = z.object({ q: z.string().min(1) }).parse(req.query);
    return support.lookup(q);
  });

  app.post('/admin/refund', { preHandler: app.requireAdmin('support.refund') }, async (req) => {
    // Refundable here: trials (4h window) and workshops (24h window). Enrollment/event refunds
    // go through their own flows. Within-window refunds require `force` (audited).
    const body = z
      .object({
        paymentType: z.enum(['trial', 'workshop']),
        paymentId: z.string().min(1),
        amountPaise: z.number().int().positive().optional(),
        force: z.boolean().optional(),
      })
      .parse(req.body);
    return support.refundPayment(req.user.adminId!, body);
  });

  app.post('/admin/cancel-booking', { preHandler: app.requireAdmin('support.action') }, async (req) => {
    const { bookingId } = z.object({ bookingId: z.string().min(1) }).parse(req.body);
    return support.cancelBooking(req.user.adminId!, bookingId);
  });

  app.post('/admin/cancel-enrollment', { preHandler: app.requireAdmin('support.action') }, async (req) => {
    const { enrollmentId } = z.object({ enrollmentId: z.string().min(1) }).parse(req.body);
    return support.cancelEnrollment(req.user.adminId!, enrollmentId);
  });

  app.post('/admin/resend-otp', { preHandler: app.requireAdmin('support.action') }, async (req) => {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    return support.resendOtp(req.user.adminId!, userId);
  });

  app.post('/admin/resend-push', { preHandler: app.requireAdmin('support.action') }, async (req) => {
    const body = z
      .object({ subjectId: z.string().min(1), role: z.enum(['student', 'academy']), title: z.string().min(1), body: z.string().min(1) })
      .parse(req.body);
    return support.resendPush(req.user.adminId!, body);
  });

  app.post('/admin/unstick-booking', { preHandler: app.requireAdmin('support.action') }, async (req) => {
    const { bookingId } = z.object({ bookingId: z.string().min(1) }).parse(req.body);
    return support.unstickBooking(req.user.adminId!, bookingId);
  });

  // ---------- Refunds console ----------
  app.get('/admin/refunds', { preHandler: app.requireAdmin('refunds.read') }, async (req) => {
    const { status } = z.object({ status: z.enum(['requested', 'failed']).default('failed') }).parse(req.query);
    return support.listRefunds(status);
  });

  app.post('/admin/refunds/retry', { preHandler: app.requireAdmin('refunds.retry') }, async (req) => {
    const body = z.object({ paymentType: PaymentTypeEnum, paymentId: z.string().min(1) }).parse(req.body);
    return support.retryRefund(req.user.adminId!, body);
  });

  // ---------- Discontinuation oversight ----------
  app.get('/admin/discontinuations', { preHandler: app.requireAdmin('discontinuations.read') }, async () => {
    return discontinuation.listDiscontinuations();
  });

  app.post('/admin/batches/:id/refund-blocker', { preHandler: app.requireAdmin('discontinuations.action') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { enrollmentId } = z.object({ enrollmentId: z.string().min(1) }).parse(req.body);
    return discontinuation.refundBlocker(req.user.adminId!, id, enrollmentId);
  });

  app.post('/admin/batches/:id/force-close', { preHandler: app.requireAdmin('discontinuations.action') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return discontinuation.forceClose(req.user.adminId!, id);
  });

  // ---------- Analytics (read-only) ----------
  const WindowSchema = z.object({ windowDays: z.coerce.number().int().min(1).max(365).optional() });

  app.get('/admin/analytics/platform', { preHandler: app.requireAdmin('analytics.read') }, async (req) => {
    const { windowDays } = WindowSchema.parse(req.query);
    return analytics.platformAnalytics(windowDays);
  });

  app.get('/admin/analytics/academies', { preHandler: app.requireAdmin('analytics.read') }, async () => {
    return analytics.analyticsAcademies();
  });

  app.get('/admin/analytics/academy/:id', { preHandler: app.requireAdmin('analytics.read') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { windowDays } = WindowSchema.parse(req.query);
    const result = await analytics.academyAnalytics(id, windowDays);
    if (!result) throw new AppError('NOT_FOUND', 404, 'Academy not found');
    return result;
  });

  // ---------- Events (platform-owned CRUD + registrations + refund) ----------
  const EventBodySchema = z.object({
    type: z.enum(['competition', 'workshop', 'meetup']),
    title: z.string().min(1).max(200),
    category: z.array(z.enum(['music', 'dance', 'arts', 'yoga'])).min(1, 'Pick at least one category'),
    description: z.string().min(1),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    location: z.string().min(1),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    pricePaise: z.number().int().min(0),
    organizerName: z.string().min(1),
    coverColor: z.string().min(1).max(20),
    coverImageUrl: z.string().url().nullable().optional(),
    galleryImageUrls: z.array(z.string().url()).optional(),
    registrationOpensAt: z.string().datetime().nullable().optional(),
    registrationDeadline: z.string().datetime().nullable().optional(),
    prizePaise: z.number().int().min(0).nullable().optional(),
    isSpotlight: z.boolean().optional(),
    divisions: z.array(z.string()).optional(),
  });

  app.get('/admin/events', { preHandler: app.requireAdmin('events.read') }, async (req) => {
    const { status } = z.object({ status: z.enum(['scheduled', 'cancelled']).optional() }).parse(req.query);
    return events.listEvents(status);
  });

  app.get('/admin/events/:id', { preHandler: app.requireAdmin('events.read') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return events.getEvent(id);
  });

  app.post('/admin/events', { preHandler: app.requireAdmin('events.write') }, async (req) => {
    const body = EventBodySchema.parse(req.body);
    return events.createEvent(req.user.adminId!, body);
  });

  app.patch('/admin/events/:id', { preHandler: app.requireAdmin('events.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = EventBodySchema.parse(req.body);
    return events.updateEvent(req.user.adminId!, id, body);
  });

  app.delete('/admin/events/:id', { preHandler: app.requireAdmin('events.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return events.deleteEvent(req.user.adminId!, id);
  });

  app.post('/admin/events/:id/cancel', { preHandler: app.requireAdmin('events.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { reason } = ReasonSchema.parse(req.body);
    return events.cancelEvent(req.user.adminId!, id, reason);
  });

  app.post('/admin/event-registrations/:id/refund', { preHandler: app.requireAdmin('events.refund') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    return events.refundRegistration(req.user.adminId!, id, force);
  });

  // Generic admin image upload (multipart) → returns { url }. Used by the event-image form (#7);
  // the returned URL is then embedded in the create/update body (coverImageUrl / galleryImageUrls).
  app.post('/admin/uploads', { preHandler: app.requireAdmin() }, async (req) => {
    const data = await req.file();
    if (!data) throw new AppError('VALIDATION', 400, 'No file uploaded');
    const buffer = await data.toBuffer();
    const { storeMedia } = await import('../../lib/media-storage.js');
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    return storeMedia({ keyPrefix: 'admin/events', buffer, mimeType: data.mimetype, baseUrl });
  });

  // ---------- Moderation (content hide/remove) ----------
  const HiddenSchema = z.object({ hidden: z.boolean() });

  app.get('/admin/moderation/reviews', { preHandler: app.requireAdmin('moderation.read') }, async (req) => {
    const { filter } = z.object({ filter: z.enum(['all', 'hidden']).default('all') }).parse(req.query);
    return moderation.listReviews(filter);
  });

  app.post('/admin/moderation/reviews/:id/comment', { preHandler: app.requireAdmin('moderation.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { hidden } = HiddenSchema.parse(req.body);
    return moderation.setReviewFieldHidden(req.user.adminId!, id, 'comment', hidden);
  });

  app.post('/admin/moderation/reviews/:id/response', { preHandler: app.requireAdmin('moderation.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { hidden } = HiddenSchema.parse(req.body);
    return moderation.setReviewFieldHidden(req.user.adminId!, id, 'response', hidden);
  });

  app.get('/admin/moderation/academies/:id/media', { preHandler: app.requireAdmin('moderation.read') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return moderation.getAcademyMedia(id);
  });

  app.post('/admin/moderation/media/:id', { preHandler: app.requireAdmin('moderation.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { hidden } = HiddenSchema.parse(req.body);
    return moderation.setMediaHidden(req.user.adminId!, id, hidden);
  });

  app.post('/admin/moderation/academies/:id/remove-image', { preHandler: app.requireAdmin('moderation.write') }, async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body);
    return moderation.removeAcademyImage(req.user.adminId!, id, url);
  });

  // ---------- Broadcast (segment push) ----------
  const SegmentEnum = z.enum(['students', 'academies', 'all']);

  app.get('/admin/broadcast/audience', { preHandler: app.requireAdmin('broadcast.read') }, async (req) => {
    const { segment } = z.object({ segment: SegmentEnum }).parse(req.query);
    return broadcast.audience(segment);
  });

  app.post('/admin/broadcast', { preHandler: app.requireAdmin('broadcast.send') }, async (req) => {
    const body = z
      .object({ segment: SegmentEnum, title: z.string().min(1).max(120), body: z.string().min(1).max(500) })
      .parse(req.body);
    return broadcast.broadcast(req.user.adminId!, body);
  });
};
