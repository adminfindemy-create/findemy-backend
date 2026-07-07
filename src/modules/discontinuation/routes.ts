import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import * as service from './service.js';

export const discontinuationRoutes: FastifyPluginAsync = async (app) => {
  // Request discontinuation → batch enters `closing`.
  app.post('/studio/batches/:id/discontinue', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.discontinueBatch(id, req.user.academy_id!);
  });

  // Closing state: notice countdown + blocking roster + can-finish gate.
  app.get('/studio/batches/:id/discontinuation', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBatchDiscontinuation(id, req.user.academy_id!);
  });

  // Refund a blocking student (pro-rated) to accelerate discontinuation.
  app.post('/studio/batches/:id/discontinuation/refund', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const { enrollment_id } = (req.body as { enrollment_id?: string }) ?? {};
    if (!enrollment_id) throw new AppError('VALIDATION', 400, 'enrollment_id is required');
    return service.refundBlockerEnrollment(id, enrollment_id, req.user.academy_id!);
  });

  // Finish → batch `ended` (only when the notice + serve-out gates are clear).
  app.post('/studio/batches/:id/finish-discontinuation', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.finishDiscontinuation(id, req.user.academy_id!);
  });
};
