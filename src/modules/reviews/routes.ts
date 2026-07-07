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

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  app.post('/reviews', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = CreateSchema.parse(req.body);
    return service.createReview(req.user.id, body);
  });


};
