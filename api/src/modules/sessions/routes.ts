import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';
import { writeStaffAudit } from '../../lib/audit-actor.js';
import { batchScope } from '../../lib/scope.js';

const CancelSchema = z.object({
  batch_id: z.string().min(1),
  session_date: z.string().min(1), // 'yyyy-MM-dd'
});

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  // S3.4: cancel a class session → unbilled + make-good (replaces the old slot hard-delete).
  app.post('/studio/sessions/cancel', { preHandler: app.requireAuth('academy', 'sessions.cancel') }, async (req) => {
    const body = CancelSchema.parse(req.body);
    const result = await service.cancelSession(
      batchScope(req.user, 'sessions.cancel'),
      body.batch_id,
      body.session_date,
      req.user.id,
    );
    // A cancellation is unbilled and made good (+1 session appended), so it moves money and
    // entitlement — exactly the class of act the audit trail exists for.
    await writeStaffAudit(req, {
      action: 'session.cancel', targetType: 'Batch', targetId: body.batch_id,
      after: { session_date: body.session_date },
    });
    return result;
  });
};
