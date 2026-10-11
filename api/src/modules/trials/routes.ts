import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { OTP_ATTENDANCE_LENGTH } from '@findemy/types';
import * as service from './service.js';
import { batchScope } from '../../lib/scope.js';

const AttendanceSchema = z.object({
  otp_code: z.string().length(OTP_ATTENDANCE_LENGTH), // S2.2: 4-digit
});

export const trialRoutes: FastifyPluginAsync = async (app) => {
  app.get('/trials/my', { preHandler: app.requireAuth('student') }, async (req) => {
    const { status } = req.query as { status?: 'upcoming' | 'past' };
    return service.getMyTrials(req.user.id, status);
  });

  app.get('/trials/today', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getTodayTrials(req.user.id);
  });

  app.get('/trials/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getTrialById(id, req.user.id);
  });

  app.post('/studio/trials/:id/attendance', { preHandler: app.requireAuth('academy', 'trials.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = AttendanceSchema.parse(req.body);
    return service.markAttendance({
      trialId: id,
      accountId: req.user.id,
      otpCode: body.otp_code,
      scope: batchScope(req.user, 'trials.manage'),
    });
  });

  app.post('/studio/trials/:id/no-show', { preHandler: app.requireAuth('academy', 'trials.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.markNoShow({
      trialId: id,
      accountId: req.user.id,
      scope: batchScope(req.user, 'trials.manage'),
    });
  });
};
