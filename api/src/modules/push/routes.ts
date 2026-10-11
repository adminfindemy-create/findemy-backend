import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import * as service from './service.js';

const RegisterSchema = z.object({
  expo_token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

export const pushRoutes: FastifyPluginAsync = async (app) => {
  app.post('/push/register', { preHandler: app.requireAuth() }, async (req) => {
    const body = RegisterSchema.parse(req.body);
    // Push tokens belong to the two mobile-app roles; admins use the browser Ops Console.
    if (req.user.role === 'admin') {
      throw new AppError('FORBIDDEN', 403, 'Admins cannot register push tokens');
    }
    return service.registerPushToken({
      subjectId: req.user.id,
      // A STAFF login's token must be stored under 'staff', not 'academy'. `req.user.role` is
      // 'academy' for both kinds (the claim names the audience), so without `sub_kind` here a
      // manager's device would register under the owner's subject role and the branch-filtered
      // fan-out would never find it.
      subjectRole: req.user.role === 'academy' && req.user.sub_kind === 'staff' ? 'staff' : req.user.role,
      token: body.expo_token,
      platform: body.platform,
    });
  });

  app.delete('/push/register', { preHandler: app.requireAuth() }, async (req) => {
    const { token } = req.query as { token: string };
    return service.unregisterPushToken(token);
  });
};
