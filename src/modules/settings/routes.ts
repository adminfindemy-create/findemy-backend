import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/studio/settings', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getSettings(req.user.id);
  });

  app.put('/studio/settings', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.updateSettings(req.user.id, req.body as Record<string, unknown>);
  });
};
