import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CancelSchema = z.object({
  batch_id: z.string().min(1),
  session_date: z.string().min(1), // 'yyyy-MM-dd'
});

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  // S3.4: cancel a class session → unbilled + make-good (replaces the old slot hard-delete).
  app.post('/studio/sessions/cancel', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = CancelSchema.parse(req.body);
    return service.cancelSession(req.user.academy_id!, body.batch_id, body.session_date);
  });
};
