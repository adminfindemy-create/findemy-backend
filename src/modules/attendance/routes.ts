// S3.2: in-studio attendance is QR-only (manual present/absent marking removed).
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CheckinSchema = z.object({ token: z.string().min(1) });

export const attendanceRoutes: FastifyPluginAsync = async (app) => {
  // Academy: issue today's QR check-in token for an in-studio session.
  app.post('/studio/batches/:id/session/checkin-token', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.issueCheckinToken(req.user.academy_id!, id);
  });

  // Academy: live "N of M checked in" roster (scanned / not-yet).
  app.get('/studio/batches/:id/session/attendance', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const { date } = req.query as { date?: string };
    return service.getSessionAttendance(id, date);
  });

  // Student: scan the QR → mark present (idempotent).
  app.post('/attendance/checkin', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = CheckinSchema.parse(req.body);
    return service.checkin(req.user.id, body.token);
  });
};
