import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const programRoutes: FastifyPluginAsync = async (app) => {
  app.get('/programs/:id', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    // Optional branch scope: programs are brand-level, so the caller says which location it
    // is asking about. Omitted → every active batch across the brand.
    const { academy_id } = req.query as { academy_id?: string };
    return service.getProgramById(id, academy_id);
  });
};
