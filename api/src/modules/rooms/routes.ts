import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';
import { batchScope } from '../../lib/scope.js';

export const roomRoutes: FastifyPluginAsync = async (app) => {
  app.get('/rooms/batch/:batch_id/token', { preHandler: app.requireAuth('student') }, async (req) => {
    const { batch_id } = req.params as { batch_id: string };
    const { learner_id } = req.query as { learner_id?: string };
    return service.getBatchToken(batch_id, req.user.id, learner_id);
  });

  app.get('/rooms/workshop/:workshop_id/token', { preHandler: app.requireAuth('student') }, async (req) => {
    const { workshop_id } = req.params as { workshop_id: string };
    return service.getWorkshopToken(workshop_id, req.user.id);
  });

  // S3.3: academy "Start live class" → host token for the batch's 100ms room.
  app.post('/studio/batches/:batch_id/live/start', { preHandler: app.requireAuth('academy', 'sessions.live') }, async (req) => {
    const { batch_id } = req.params as { batch_id: string };
    return service.startLiveClass(batchScope(req.user, 'sessions.live'), batch_id, req.user.id);
  });

  // S3.3: 100ms webhook → real-join attendance (signed; no app auth). rawBody for HMAC verify.
  app.post('/rooms/100ms/webhook', { config: { rawBody: true } }, async (req, reply) => {
    const signature = (req.headers['x-100ms-signature'] as string) ?? '';
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
    const result = await service.handleHmsWebhook(req.body as Record<string, any>, signature, rawBody);
    return reply.send(result);
  });
};
