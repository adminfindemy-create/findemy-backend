import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const Gender = z.enum(['male', 'female', 'other']);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-MM-dd');

const AddSchema = z.object({
  name: z.string().trim().min(1).max(80),
  dob: DateOnly,
  gender: Gender.optional(),
  // The guardian ticked the consent box in the app. Required by DPDP before storing a minor's data.
  consent: z.literal(true),
});

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  dob: DateOnly.nullable().optional(),
  gender: Gender.nullable().optional(),
});

export const familyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/family/learners', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.listLearners(req.user.id);
  });

  app.post('/family/learners', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = AddSchema.parse(req.body);
    return service.addLearner(req.user.id, body);
  });

  app.patch('/family/learners/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.updateLearner(req.user.id, id, UpdateSchema.parse(req.body));
  });

  app.delete('/family/learners/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.archiveLearner(req.user.id, id);
  });

  app.get('/family/dashboard', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getDashboard(req.user.id);
  });

  app.get('/learners/:id/attendance', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    return service.getLearnerAttendance(req.user.id, id, month);
  });
};
