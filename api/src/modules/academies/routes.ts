import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const CategoryEnum = z.enum(['music', 'dance', 'arts', 'yoga']);

export const ListQuerySchema = z.object({
  q: z.string().optional(),
  category: CategoryEnum.optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radius_km: z.coerce.number().optional(),
  online: z.coerce.boolean().optional(),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  /**
   * Budget filter — the cheapest monthly fee across an academy's batches must be at or under
   * this. In paise, like every other money value on the wire. Applied the same way as
   * `min_rating`: after the rows come back, over the derived `monthly_from_paise`.
   */
  max_monthly_paise: z.coerce.number().min(0).optional(),
  /**
   * Learner age bracket, in years (inclusive). Keeps an academy only if it runs ≥1 active batch
   * whose age range overlaps it; a null bound on either side is open-ended, so an "all ages"
   * batch always matches. Pass the same value for both to ask about one exact age.
   */
  age_min: z.coerce.number().int().min(0).max(100).optional(),
  age_max: z.coerce.number().int().min(0).max(100).optional(),
  sort: z.enum(['rating', 'distance', 'top_rated']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).optional(),
});

export const CategoryCountsQuerySchema = z.object({
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radius_km: z.coerce.number().positive().optional(),
});

export const academyRoutes:FastifyPluginAsync = async (app) => {
  app.get('/academies', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const query = ListQuerySchema.parse(req.query);
    return service.listAcademies(query);
  });

  app.get('/academies/category-counts', async (req) => {
    const query = CategoryCountsQuerySchema.parse(req.query);
    return service.getCategoryCounts(query);
  });

  app.get('/academies/:id', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    return service.getAcademyById(id, req.user?.id);
  });

  app.get('/academies/:id/reviews', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { id } = req.params as { id: string };
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    return service.getAcademyReviews(id, cursor, limit ? Number(limit) : undefined);
  });
};
