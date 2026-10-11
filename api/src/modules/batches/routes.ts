import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const batchRoutes: FastifyPluginAsync = async (app) => {
  // S2.1: trial-availability derived from the batch's class timings (slots retired).
  app.get('/batches/:id/trial-availability', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getTrialAvailability(id);
  });

  app.get('/batches/:id/availability', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getBatchAvailability(id);
  });

  app.post('/batches/:id/enroll', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { package_type = 'monthly', learner_id } = (req.body as any) ?? {};
    return service.enrollStudent(id, req.user.id, package_type, learner_id);
  });

  app.delete('/batches/:id/enroll', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { learner_id } = req.query as { learner_id?: string };
    return service.unenrollStudent(id, req.user.id, learner_id);
  });

  app.get('/batches/:id/enrollment', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { learner_id } = req.query as { learner_id?: string };
    return service.getEnrollmentStatus(id, req.user.id, learner_id);
  });

  app.get('/batches/:id/renewal-options', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { learner_id } = req.query as { learner_id?: string };
    return service.getBatchRenewalOptions(id, req.user.id, learner_id);
  });

  app.post('/batches/:id/renew', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { package_type, learner_id } = req.body as { package_type: string; learner_id?: string };
    return service.renewBatchEnrollment(id, req.user.id, package_type, learner_id);
  });
};
