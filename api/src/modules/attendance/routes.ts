// In-studio attendance: the teacher enters each student's own 4-digit code (the same one they
// carry for trials), from 10 minutes before the class until it ends. The QR that students used to
// scan is gone.
//
// The register then stays correctable for 24 hours after the class — see service.correctAttendance.
// Everything under /studio/attendance and /studio/batches/:id/attendance is the REVIEW side —
// reading the record back by month (see review.ts).
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';
import * as review from './review.js';
import { batchScope } from '../../lib/scope.js';
import { learnerIdFromStudentRef } from '../../lib/learner-access.js';

// Students are named by `learner_id`. Older academy-app builds send `user_id`, which maps to that
// account's own learner (learnerIdFromStudentRef).
const StudentRef = {
  learner_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
};
const MarkSchema = z.object({ ...StudentRef, otp_code: z.string().length(4) });
const CorrectSchema = z.object({ ...StudentRef, present: z.boolean(), reason: z.string().trim().max(200).optional() });

export const attendanceRoutes: FastifyPluginAsync = async (app) => {
  // Academy: mark one student present by entering their attendance code.
  app.post('/studio/batches/:id/session/mark', { preHandler: app.requireAuth('academy', 'attendance.session.start') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = MarkSchema.parse(req.body);
    return service.markPresentByOtp(
      batchScope(req.user, 'attendance.session.start'),
      id,
      await learnerIdFromStudentRef(body),
      body.otp_code,
    );
  });

  // Student (guardian): the attendance code for this enrollment's class — only while the window is
  // open; otherwise `code: null` and when it opens.
  app.get('/enrollments/:id/attendance-code', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getClassCode(req.user.id, id);
  });

  // Academy: correct one student's attendance, up to 24h after the class ended.
  // Separate permission from marking: a teacher marks every class, but changing a record after
  // the fact is the reviewable act — hence its own key, and `markedByAccountId` recording who.
  app.patch('/studio/batches/:id/sessions/:date/attendance', { preHandler: app.requireAuth('academy', 'attendance.correct') }, async (req) => {
    const { id, date } = req.params as { id: string; date: string };
    const body = CorrectSchema.parse(req.body);
    return service.correctAttendance(
      batchScope(req.user, 'attendance.correct'),
      id,
      date,
      await learnerIdFromStudentRef(body),
      body.present,
      req.user.id,
      body.reason,
    );
  });

  // Academy: live "N of M checked in" roster (scanned / not-yet).
  // `academy_id` is passed for the same reason every sibling handler passes it: the batch id
  // comes from the URL, so without it any authenticated academy login could read another
  // brand's roster by guessing an id.
  app.get('/studio/batches/:id/session/attendance', { preHandler: app.requireAuth('academy', 'attendance.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const { date } = req.query as { date?: string };
    return service.getSessionAttendance(batchScope(req.user, 'attendance.view'), id, date);
  });

  // ---------- review (L1 → L3b) ----------

  // L1: every batch's month at a glance.
  app.get('/studio/attendance', { preHandler: app.requireAuth('academy', 'attendance.view') }, async (req) => {
    const { month, q } = req.query as { month?: string; q?: string };
    return review.getAttendanceOverview(batchScope(req.user, 'attendance.view'), month, q);
  });

  // L2: one batch — sessions list + students list (two native lists, not a matrix).
  app.get('/studio/batches/:id/attendance', { preHandler: app.requireAuth('academy', 'attendance.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    return review.getBatchAttendance(batchScope(req.user, 'attendance.view'), id, month);
  });

  // L2 → export: the students × sessions matrix, for a screen wide enough to read it.
  app.get('/studio/batches/:id/attendance.csv', { preHandler: app.requireAuth('academy', 'attendance.export') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    const { filename, csv } = await review.getBatchAttendanceCsv(batchScope(req.user, 'attendance.export'), id, month);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    return reply.send(csv);
  });

  // L3a: one session — who was there, and when they checked in.
  app.get('/studio/batches/:id/sessions/:date', { preHandler: app.requireAuth('academy', 'attendance.view') }, async (req) => {
    const { id, date } = req.params as { id: string; date: string };
    return review.getSessionDetail(batchScope(req.user, 'attendance.view'), id, date);
  });

  // L3b: one student's month, day by day, plus their paid-period figure.
  app.get('/studio/students/:id/attendance', { preHandler: app.requireAuth('academy', 'attendance.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const { month } = req.query as { month?: string };
    return review.getStudentAttendance(batchScope(req.user, 'attendance.view'), id, month);
  });
};
