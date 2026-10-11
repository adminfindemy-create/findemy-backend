import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CreateOrderSchema = z.object({
  booking_id: z.string().min(1),
});

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/payments/order', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = CreateOrderSchema.parse(req.body);
    return service.createOrder({ bookingId: body.booking_id, userId: req.user.id });
  });

  // Free trials (trial fee 0) confirm here instead of through a Razorpay order + webhook.
  app.post('/payments/confirm-free', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = CreateOrderSchema.parse(req.body);
    return service.confirmFreeBooking({ bookingId: body.booking_id, userId: req.user.id });
  });

  app.post('/payments/webhook', {
    // Allow large raw body for signature verification
    config: { rawBody: true },
  }, async (req, reply) => {
    const signature = (req.headers['x-razorpay-signature'] as string) ?? '';
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
    const result = await service.handleWebhook(req.body as Record<string, unknown>, signature, rawBody);
    return reply.send(result);
  });

  app.get('/payments/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getPayment(id);
  });
};
