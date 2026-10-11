import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import * as service from './service.js';
import { writeStaffAudit } from '../../lib/audit-actor.js';

export const discontinuationRoutes: FastifyPluginAsync = async (app) => {
  // Request discontinuation → batch enters `closing`.
  app.post('/studio/batches/:id/discontinue', { preHandler: app.requireAuth('academy', 'batches.discontinue') }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await service.discontinueBatch(id, req.user.academy_id!);
    await writeStaffAudit(req, { action: 'batch.discontinue', targetType: 'Batch', targetId: id });
    return result;
  });

  // Closing state: notice countdown + blocking roster + can-finish gate.
  app.get('/studio/batches/:id/discontinuation', { preHandler: app.requireAuth('academy', 'batches.discontinue') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBatchDiscontinuation(id, req.user.academy_id!);
  });

  // Refund a blocking student (pro-rated) to accelerate discontinuation.
  app.post('/studio/batches/:id/discontinuation/refund', { preHandler: app.requireAuth('academy', 'refunds.issue') }, async (req) => {
    const { id } = req.params as { id: string };
    const { enrollment_id } = (req.body as { enrollment_id?: string }) ?? {};
    if (!enrollment_id) throw new AppError('VALIDATION', 400, 'enrollment_id is required');
    const result = await service.refundBlockerEnrollment(id, enrollment_id, req.user.academy_id!);
    // EVERY refund is logged. This route moves real money out via Razorpay on an academy
    // token, which is why `refunds.issue` is the one key carrying an explicit deny row.
    await writeStaffAudit(req, {
      action: 'refund.issue', targetType: 'Enrollment', targetId: enrollment_id,
      after: { batch_id: id, ...result },
    });
    return result;
  });

  // Finish → batch `ended` (only when the notice + serve-out gates are clear).
  app.post('/studio/batches/:id/finish-discontinuation', { preHandler: app.requireAuth('academy', 'batches.discontinue') }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await service.finishDiscontinuation(id, req.user.academy_id!);
    await writeStaffAudit(req, { action: 'batch.discontinue.finish', targetType: 'Batch', targetId: id });
    return result;
  });
};
