import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BatchTimingInput } from '@findemy/types';
import * as service from './service.js';
import * as uploadService from './upload.js';

const BatchCreateSchema = z.object({
  // Every batch is created under a program (no standalone batch creation). Title/category/
  // description/things_to_know are owned by the program and derived server-side.
  program_id: z.string().min(1),
  coach_id: z.string().min(1),
  level: z.string().min(1),
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
});

const MediaItem = z.object({ url: z.string().min(1), type: z.enum(['photo', 'video']) });

const ProgramCreateSchema = z.object({
  title: z.string().min(1),
  category: z.enum(['music', 'dance', 'arts', 'yoga']),
  description: z.string().min(1),
  things_to_know: z.array(z.string()).optional(),
  // At least 3 photos/videos (max 10 combined).
  media: z.array(MediaItem).min(3, 'Add at least 3 photos or videos').max(10, 'Up to 10 media items'),
});

const ProgramUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  things_to_know: z.array(z.string()).optional(),
  // If provided, replaces the program's media (min 3, max 10).
  media: z.array(MediaItem).min(3).max(10).optional(),
}).strict();

const ReviewRespondSchema = z.object({
  response: z.string().min(1),
});

const AcademyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.enum(['music', 'dance', 'arts', 'yoga']).optional(),
  address: z.string().optional(),
  bio: z.string().optional(),
  tagline: z.string().optional(),
  specialities: z.array(z.string()).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  bank_account_number: z.string().optional(),
  bank_ifsc: z.string().optional(),
  bank_holder_name: z.string().optional(),
  images: z.array(z.string()).optional(),
}).strict();

const BatchUpdateSchema = z.object({
  coach_id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  category: z.enum(['music', 'dance', 'arts', 'yoga']).optional(),
  level: z.string().optional(),
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
}).strict();

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
      leaderboard: z.boolean().optional(),
      reels: z.boolean().optional(),
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
  app.get('/studio/dashboard', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getDashboard(req.user.academy_id!);
  });

  app.get('/studio/academy', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getAcademy(req.user.academy_id!);
  });

  app.put('/studio/academy', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = AcademyUpdateSchema.parse(req.body);
    return service.updateAcademy(req.user.academy_id!, body);
  });

  app.get('/studio/batches', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getBatches(req.user.academy_id!);
  });

  app.get('/studio/batches/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBatch(id, req.user.academy_id!);
  });

  app.post('/studio/batches', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = BatchCreateSchema.parse(req.body);
    return service.createBatch(req.user.academy_id!, body);
  });

  app.put('/studio/batches/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = BatchUpdateSchema.parse(req.body);
    return service.updateBatch(id, req.user.academy_id!, body);
  });

  app.delete('/studio/batches/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.deleteBatch(id, req.user.academy_id!);
  });

  app.get('/studio/batches/:id/students', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBatchStudents(id, req.user.academy_id!);
  });

  // --- Program media upload (photos/videos) ---
  app.post('/studio/media/upload', { preHandler: app.requireAuth('academy') }, async (req) => {
    const data = await req.file();
    if (!data) throw new Error('No file uploaded');
    const buffer = await data.toBuffer();
    const { storeMedia } = await import('../../lib/media-storage.js');
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    return storeMedia({ keyPrefix: `programs/${req.user.academy_id!}`, buffer, mimeType: data.mimetype, baseUrl });
  });

  // --- Programs ---
  app.get('/studio/programs', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getPrograms(req.user.academy_id!);
  });

  app.get('/studio/programs/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getProgramDetail(id, req.user.academy_id!);
  });

  app.post('/studio/programs', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = ProgramCreateSchema.parse(req.body);
    return service.createProgram(req.user.academy_id!, body);
  });

  app.put('/studio/programs/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ProgramUpdateSchema.parse(req.body);
    return service.updateProgram(id, req.user.academy_id!, body);
  });

  app.delete('/studio/programs/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.deleteProgram(id, req.user.academy_id!);
  });

  app.get('/studio/schedule', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { week_start } = req.query as { week_start?: string };
    return service.getSchedule(req.user.academy_id!, week_start);
  });

  app.get('/studio/inbox', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { status } = req.query as { status?: string };
    return service.getInbox(req.user.academy_id!, status);
  });

  app.get('/studio/trials/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getTrialDetail(id, req.user.academy_id!);
  });

  app.get('/studio/activity', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getActivity(req.user.academy_id!);
  });

  app.get('/studio/students', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { q, batch_id, attendance_tier } = req.query as { q?: string; batch_id?: string; attendance_tier?: 'active' | 'irregular' | 'inactive' };
    return service.getStudents(req.user.academy_id!, q, batch_id, attendance_tier);
  });

  app.get('/studio/students/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getStudent(id, req.user.academy_id!);
  });

  app.get('/studio/reviews', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { filter } = req.query as { filter?: 'all' | 'needs_reply' | 'replied' | '5' | 'lte3' };
    return service.getReviews(req.user.academy_id!, filter);
  });

  app.get('/studio/reviews/summary', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getReviewsSummary(req.user.academy_id!);
  });

  app.post('/studio/reviews/:id/respond', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ReviewRespondSchema.parse(req.body);
    return service.respondToReview(id, req.user.academy_id!, body.response);
  });

  app.get('/studio/earnings', { preHandler: app.requireAuth('academy') }, async (req) => {
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

  app.get('/studio/settings', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getSettings(req.user.id);
  });

  app.put('/studio/settings', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = SettingsUpdateSchema.parse(req.body);
    return service.updateSettings(req.user.id, body);
  });

  app.post('/studio/academy/upload', { preHandler: app.requireAuth('academy') }, async (req) => {
    const data = await req.file();
    if (!data) throw new Error('No file uploaded');
    const buffer = await data.toBuffer();
    const mimeType = data.mimetype;
    const imageUrl = await uploadService.uploadAcademyImage(req.user.academy_id!, buffer, mimeType);
    const result = await uploadService.addAcademyImage(req.user.academy_id!, imageUrl);
    return { url: imageUrl, images: result.images };
  });

  app.delete('/studio/academy/image', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { url } = req.body as { url: string };
    if (!url) throw new Error('url required');
    const result = await uploadService.removeAcademyImage(req.user.academy_id!, url);
    return { images: result.images };
  });
};
