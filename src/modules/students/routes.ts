import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const studentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/studio/students', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { q } = req.query as { q?: string };
    return service.getStudents(req.user.academy_id!, q);
  });

  app.get('/studio/students/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getStudent(id, req.user.academy_id!);
  });
};
