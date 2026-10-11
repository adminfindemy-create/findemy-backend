import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CreateSchema = z
  .object({
    source: z.enum(['trial', 'enrollment']),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(1000).optional(),
    trial_id: z.string().optional(),
    academy_id: z.string().optional(),
    batch_id: z.string().optional(),
  })
  .refine((d) => (d.source === 'trial' ? !!d.trial_id : !!d.academy_id && !!d.batch_id), {
    message: 'trial: trial_id required; enrollment: academy_id + batch_id required',
  });

// Both fields optional — a rating-only change must not force the client to resend the note.
// `.refine` keeps a completely empty body out: that is a client bug, not a no-op save.
const UpdateSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    comment: z.string().max(1000).optional(),
  })
  .refine((d) => d.rating !== undefined || d.comment !== undefined, {
    message: 'rating or comment is required',
  });

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  app.post('/reviews', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = CreateSchema.parse(req.body);
    return service.createReview(req.user.id, body);
  });

  app.patch('/reviews/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateSchema.parse(req.body);
    return service.updateReview(req.user.id, id, body);
  });

  app.delete('/reviews/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.deleteReview(req.user.id, id);
  });
};
