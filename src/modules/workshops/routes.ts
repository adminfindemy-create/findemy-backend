import type { FastifyPluginAsync } from 'fastify';
import { CreateWorkshopRequest, UpdateWorkshopRequest } from '@findemy/types';
import * as service from './service.js';

export const workshopRoutes: FastifyPluginAsync = async (app) => {
  app.get('/workshops', { preHandler: app.requireAuth('student') }, async () => {
    return service.listAll();
  });

  app.get('/workshops/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getWorkshop(id);
  });

  app.post('/workshops/:id/register', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.registerForWorkshop(id, req.user.id);
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

  app.get('/academies/:id/workshops', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.listForAcademy(id);
  });

  app.get('/studio/workshops', { preHandler: app.requireAuth('academy') }, async (req) => {
    const academyId = req.user.academy_id!;
    return service.listForStudio(academyId);
  });

  // Academy: who booked this workshop (name, phone, booking/payment status).
  app.get('/studio/workshops/:id/registrations', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getWorkshopRegistrations(req.user.academy_id!, id);
  });

  app.post('/studio/workshops', { preHandler: app.requireAuth('academy') }, async (req) => {
    const academyId = req.user.academy_id!;
    const body = CreateWorkshopRequest.parse(req.body);
    return service.createWorkshop(academyId, body);
  });

  app.put('/studio/workshops/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const academyId = req.user.academy_id!;
    const body = UpdateWorkshopRequest.parse(req.body);
    return service.updateWorkshop(id, academyId, body);
  });

  app.delete('/studio/workshops/:id', { preHandler: app.requireAuth('academy') }, async (req) => {
    const { id } = req.params as { id: string };
    const academyId = req.user.academy_id!;
    return service.deleteWorkshop(id, academyId);
  });
};
