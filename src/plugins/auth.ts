import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens.js';
import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorate(
    'requireAuth',
    (role?: 'student' | 'academy') =>
      async (req: FastifyRequest) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
          throw new AppError('UNAUTHORIZED', 401, 'Missing token');
        }
        const token = header.slice(7);
        let payload: { sub: string; role: string; academy_id?: string };
        try {
          payload = await verifyAccessToken(token);
        } catch {
          throw new AppError('UNAUTHORIZED', 401, 'Invalid token');
        }

        if (role && payload.role !== role) {
          throw new AppError('FORBIDDEN', 403, 'Role mismatch');
        }

        req.user = {
          id: payload.sub,
          role: payload.role as 'student' | 'academy',
          academy_id: payload.academy_id,
        };

        if (payload.role === 'academy' && !req.user.academy_id) {
          const account = await prisma.academyAccount.findUnique({
            where: { id: payload.sub },
          });
          if (!account) {
            throw new AppError('FORBIDDEN', 403, 'Academy account not found');
          }
          // academyId is String? in Prisma; null and undefined mean the same
          // (no academy linked) for req.user.academy_id.
          req.user.academy_id = account.academyId ?? undefined;
        }
      },
  );
});
