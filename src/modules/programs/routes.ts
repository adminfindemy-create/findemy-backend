import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const programRoutes: FastifyPluginAsync = async (app) => {
  app.get('/programs/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getProgramById(id);
  });
};
