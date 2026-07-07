import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CreateSchema = z.object({
  name: z.string().min(1),
  specialty: z.string().min(1),
  bio: z.string().optional(),
  phone: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  specialty: z.string().min(1).optional(),
  bio: z.string().optional(),
  phone: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
}).strict();

export const coachRoutes: FastifyPluginAsync = async (app) => {
  app.get('/studio/coaches', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getCoaches(req.user.academy_id!);
  });

  // S4.2: coach detail + assigned batches.
  app.get('/studio/coaches/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getCoach(id, req.user.academy_id!);
  });

  app.post('/studio/coaches', { preHandler: app.requireAuth('academy') }, async (req) => {
    const body = CreateSchema.parse(req.body);
    return service.createCoach(req.user.academy_id!, body);
  });

  app.put('/studio/coaches/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateSchema.parse(req.body);
    return service.updateCoach(id, req.user.academy_id!, body);
  });

  app.delete('/studio/coaches/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.deleteCoach(id, req.user.academy_id!);
  });
};
