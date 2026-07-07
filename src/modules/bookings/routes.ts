import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CreateSchema = z.object({
  batch_id: z.string().min(1),
  trial_at: z.string().datetime(), // S2.1: chosen class-session datetime (ISO)
});

const RescheduleSchema = z.object({
  new_trial_at: z.string().datetime(),
});

const CancelSchema = z.object({
  acknowledge_no_refund: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  app.post('/bookings', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = CreateSchema.parse(req.body);
    return service.createBooking({ userId: req.user.id, batchId: body.batch_id, trialAt: body.trial_at });
  });

  app.get('/bookings/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBooking(id, req.user.id);
  });

  app.post('/bookings/:id/cancel', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body ? CancelSchema.parse(req.body) : {};
    return service.cancelBooking(id, req.user.id, {
      acknowledgeNoRefund: body.acknowledge_no_refund,
      reason: body.reason,
    });
  });

  app.post('/bookings/:id/reschedule', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = RescheduleSchema.parse(req.body);
    return service.rescheduleBooking(id, req.user.id, body.new_trial_at);
  });
};
