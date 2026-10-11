import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';
import { writeStaffAudit } from '../../lib/audit-actor.js';

// `phone` is gone from both: a coach's number lives on their StaffAccount now, because every
// coach has a login. `credentials` is experience AND qualifications in one field.
const CreateSchema = z.object({
  name: z.string().min(1),
  specialty: z.string().min(1),
  bio: z.string().optional(),
  credentials: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  specialty: z.string().min(1).optional(),
  bio: z.string().optional(),
  credentials: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
}).strict();

export const coachRoutes: FastifyPluginAsync = async (app) => {
  app.get('/studio/coaches', { preHandler: app.requireAuth('academy', 'coaches.view') }, async (req) => {
    return service.getCoaches(req.user.group_id!, req.user.allowed_branch_ids);
  });

  // S4.2: coach detail + assigned batches.
  app.get('/studio/coaches/:id', { preHandler: app.requireAuth('academy', 'coaches.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getCoach(id, req.user.group_id!);
  });

  app.post('/studio/coaches', { preHandler: app.requireAuth('academy', 'coaches.manage') }, async (req) => {
    const body = CreateSchema.parse(req.body);
    const result = await service.createCoach(req.user.group_id!, body);
    await writeStaffAudit(req, {
      action: 'coach.create', targetType: 'Coach', targetId: result.coach.id, after: body,
    });
    return result;
  });

  app.put('/studio/coaches/:id', { preHandler: app.requireAuth('academy', 'coaches.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateSchema.parse(req.body);
    const result = await service.updateCoach(id, req.user.group_id!, body);
    await writeStaffAudit(req, {
      action: 'coach.update', targetType: 'Coach', targetId: id, after: body,
    });
    return result;
  });

  app.delete('/studio/coaches/:id', { preHandler: app.requireAuth('academy', 'coaches.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await service.deleteCoach(id, req.user.group_id!);
    await writeStaffAudit(req, { action: 'coach.delete', targetType: 'Coach', targetId: id });
    return result;
  });
};
