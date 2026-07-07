import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const RegisterSchema = z.object({
  expo_token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

export const pushRoutes: FastifyPluginAsync = async (app) => {
  app.post('/push/register', { preHandler: app.requireAuth() }, async (req) => {
    const body = RegisterSchema.parse(req.body);
    return service.registerPushToken({
      subjectId: req.user.id,
      subjectRole: req.user.role,
      token: body.expo_token,
      platform: body.platform,
    });
  });

  app.delete('/push/register', { preHandler: app.requireAuth() }, async (req) => {
    const { token } = req.query as { token: string };
    return service.unregisterPushToken(token);
  });
};
