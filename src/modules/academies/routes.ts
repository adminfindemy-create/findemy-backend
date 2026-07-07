import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CategoryEnum = z.enum(['music', 'dance', 'arts', 'yoga']);

const ListQuerySchema = z.object({
  q: z.string().optional(),
  category: CategoryEnum.optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radius_km: z.coerce.number().optional(),
  online: z.coerce.boolean().optional(),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(['rating', 'distance', 'top_rated']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export const academyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/academies', { preHandler: app.requireAuth('student') }, async (req) => {
    const query = ListQuerySchema.parse(req.query);
    return service.listAcademies(query);
  });

  app.get('/academies/:id', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getAcademyById(id);
  });

  app.get('/academies/:id/reviews', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    return service.getAcademyReviews(id, cursor, limit ? Number(limit) : undefined);
  });
};
