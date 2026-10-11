import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { type } = req.query as { type?: string };
    return service.listEvents(type);
  });

  app.get('/events/:id', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getEvent(id);
  });

  app.get('/events/:id/registration', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getRegistrationStatus(id, req.user.id);
  });

  app.post('/events/:id/register', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    // Meetups / workshop events: `attendees`, one { name } per ticket. Competitions:
    // `learner_ids`, the family members taking part. Old app builds send neither → one ticket /
    // the account holder.
    const body = (req.body ?? {}) as { attendees?: { name?: unknown }[]; learner_ids?: unknown };
    return service.registerForEvent(id, req.user.id, body);
  });

  app.post('/payments/event-order', { preHandler: app.requireAuth('student') }, async (req) => {
    const { registration_id } = req.body as { registration_id: string };
    return service.createEventPaymentOrder(registration_id, req.user.id);
  });

  app.post('/events/registrations/:registrationId/cancel', { preHandler: app.requireAuth('student') }, async (req) => {
    const { registrationId } = req.params as { registrationId: string };
    return service.cancelEventRegistration(registrationId, req.user.id);
  });
};
