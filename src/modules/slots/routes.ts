import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';
import * as batchService from '../batches/service.js';

const PublishSchema = z.object({
  batch_id: z.string().min(1),
  // Legacy / quick mode: whole-day publish derived from batch timings.
  dates: z.array(z.string().min(1)).optional(),
  // Grid mode: explicit per-time slots, each with its own capacity (max trials).
  slots: z
    .array(
      z.object({
        date: z.string().min(1),
        time: z.string().min(1), // "HH:MM"
        capacity: z.number().int().min(1).max(100).optional(),
      }),
    )
    .optional(),
}).refine((d) => (d.dates && d.dates.length) || (d.slots && d.slots.length), {
  message: 'Provide dates or slots',
});

const RescheduleSchema = z.object({
  slot_time: z.string().min(1),
});

export const slotRoutes: FastifyPluginAsync = async (app) => {
  // Academy-scoped slot listing for the Studio app. Mirrors the student-facing
  // GET /batches/:id/slots but with requireAuth('academy') so the admin app
  // (which has the academy role) is not 403'd.
  // S2.1: slots retired — this legacy academy route now returns trial availability.
  app.get('/studio/batches/:id/slots', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return batchService.getTrialAvailability(id);
  });

  app.post('/studio/slots/publish', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = PublishSchema.parse(req.body);
    return service.publishSlots(req.user.academy_id!, body);
  });

  app.delete('/studio/slots/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.deleteSlot(id, req.user.academy_id!);
  });

  app.put('/studio/slots/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = RescheduleSchema.parse(req.body);
    return service.rescheduleSlot(id, req.user.academy_id!, body.slot_time);
  });
};
