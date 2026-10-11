import type { FastifyPluginAsync } from 'fastify';
import { CreateWorkshopRequest, UpdateWorkshopRequest } from '@findemy/types';
import * as service from './service.js';
import { workshopScope } from '../../lib/scope.js';

export const workshopRoutes: FastifyPluginAsync = async (app) => {
  app.get('/workshops', { preHandler: app.optionalStudentAuth() }, async () => {
    return service.listAll();
  });

  app.get('/workshops/:id', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getWorkshop(id);
  });

  app.post('/workshops/:id/register', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    // `attendees`: one { name } per ticket, the first being the account holder. Omitted by old
    // app builds → one ticket for the account holder.
    const body = (req.body ?? {}) as { attendees?: { name?: unknown }[] };
    return service.registerForWorkshop(id, req.user.id, body.attendees);
  });

  app.get('/workshops/:id/registration', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getRegistrationStatus(id, req.user.id);
  });

  app.post('/workshops/registrations/:registrationId/cancel', { preHandler: app.requireAuth('student') }, async (req) => {
    const { registrationId } = req.params as { registrationId: string };
    const body = (req.body ?? {}) as { acknowledge_no_refund?: boolean; reason?: string };
    return service.cancelWorkshopRegistration(registrationId, req.user.id, {
      acknowledgeNoRefund: body.acknowledge_no_refund,
      reason: body.reason,
    });
  });

  app.post('/payments/workshop-order', { preHandler: app.requireAuth('student') }, async (req) => {
    const { registration_id } = req.body as { registration_id: string };
    return service.createWorkshopPaymentOrder(registration_id, req.user.id);
  });

  app.get('/academies/:id/workshops', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    return service.listForAcademy(id);
  });

  app.get('/studio/workshops', { preHandler: app.requireAuth('academy', 'workshops.view') }, async (req) => {
    return service.listForStudio(workshopScope(req.user, 'workshops.view'));
  });

  // Academy: who booked this workshop (name, phone, booking/payment status).
  app.get('/studio/workshops/:id/registrations', { preHandler: app.requireAuth('academy', 'workshops.view') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getWorkshopRegistrations(workshopScope(req.user, 'workshops.view'), id);
  });

  // The teacher conducting an online workshop joins it as HOST. The student path requires a
  // registration, so without this a teacher could not enter their own workshop's room.
  app.post('/studio/workshops/:id/live/token', { preHandler: app.requireAuth('academy', 'sessions.live') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getWorkshopHostToken(workshopScope(req.user, 'workshops.view'), id, req.user.id);
  });

  app.post('/studio/workshops', { preHandler: app.requireAuth('academy', 'workshops.manage') }, async (req) => {
    const academyId = req.user.academy_id!;
    const body = CreateWorkshopRequest.parse(req.body);
    return service.createWorkshop(academyId, body, req.user.group_id);
  });

  app.put('/studio/workshops/:id', { preHandler: app.requireAuth('academy', 'workshops.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const academyId = req.user.academy_id!;
    const body = UpdateWorkshopRequest.parse(req.body);
    return service.updateWorkshop(id, academyId, body, req.user.group_id);
  });

  app.delete('/studio/workshops/:id', { preHandler: app.requireAuth('academy', 'workshops.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const academyId = req.user.academy_id!;
    return service.deleteWorkshop(id, academyId);
  });
};
