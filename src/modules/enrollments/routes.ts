import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const enrollmentRoutes: FastifyPluginAsync = async (app) => {
  // Student: get enrollment details
  app.get('/enrollments/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getEnrollment(id, req.user.id);
  });

  // Student: discontinue
  app.post('/enrollments/:id/discontinue', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { immediate = false, reason } = req.body as { immediate?: boolean; reason: string };
    return service.discontinueEnrollment(id, req.user.id, { immediate, reason });
  });

  // Student: undo discontinuation
  app.post('/enrollments/:id/cancel-discontinue', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.cancelDiscontinuation(id, req.user.id);
  });

  // Student: request pause
  app.post('/enrollments/:id/pause', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { duration, reason } = req.body as { duration: string; reason?: string };
    return service.requestPause(id, req.user.id, { duration, reason });
  });

  // Student: resume pause early
  app.post('/enrollments/:id/pauses/:pauseId/resume', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id, pauseId } = req.params as { id: string; pauseId: string };
    return service.resumePause(id, pauseId, req.user.id);
  });

  // Student: request batch transfer
  app.post('/enrollments/:id/transfer', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { target_batch_id, reason } = req.body as { target_batch_id: string; reason?: string };
    return service.requestTransfer(id, req.user.id, { target_batch_id, reason });
  });

  // Student: set preferred renewal package
  app.post('/enrollments/:id/preferred-package', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { package_type } = req.body as { package_type: string };
    return service.setPreferredPackage(id, req.user.id, package_type);
  });

  // Academy: view enrollments for a batch
  app.get('/studio/batches/:batchId/enrollments', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { batchId } = req.params as { batchId: string };
    return service.getEnrollmentsForBatch(batchId, req.user.academy_id!);
  });

  // Academy: view pending pause requests
  app.get('/studio/pause-requests', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getPendingPausesForAcademy(req.user.academy_id!);
  });

  // Academy: approve pause
  app.post('/studio/enrollments/:enrollmentId/pauses/:pauseId/approve', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { enrollmentId, pauseId } = req.params as { enrollmentId: string; pauseId: string };
    return service.approvePause(enrollmentId, pauseId, req.user.academy_id!);
  });

  // Academy: reject pause
  app.post('/studio/enrollments/:enrollmentId/pauses/:pauseId/reject', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { enrollmentId, pauseId } = req.params as { enrollmentId: string; pauseId: string };
    const { reason } = req.body as { reason: string };
    return service.rejectPause(enrollmentId, pauseId, req.user.academy_id!, reason);
  });

  // Academy: view pending transfer requests
  app.get('/studio/transfer-requests', { preHandler: app.requireAuth('academy') }, async (req) => {
    return service.getPendingTransfersForAcademy(req.user.academy_id!);
  });

  // Academy: approve transfer
  app.post('/studio/transfer-requests/:id/approve', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.approveTransfer(id, req.user.academy_id!);
  });

  // Academy: reject transfer
  app.post('/studio/transfer-requests/:id/reject', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason: string };
    return service.rejectTransfer(id, req.user.academy_id!, reason);
  });
};
