import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

export const SuggestQuery = z.object({
  q: z.string().max(100),
  // The panel shows a handful; the cap is here so a client cannot turn a type-ahead into a bulk
  // export of the catalogue.
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const searchRoutes: FastifyPluginAsync = async (app) => {
  // Type-ahead for the discover search bar. Open to guests like every other discovery read.
  app.get('/search/suggest', { preHandler: app.optionalStudentAuth() }, async (req) => {
    const { q, limit } = SuggestQuery.parse(req.query);
    return service.suggest({ q, limit });
  });

  // What the search screen shows before anything is typed: trending terms, what is being booked
  // near you, and picks from the student's own interests.
  app.get('/search/trending', { preHandler: app.optionalStudentAuth() }, async (req) => {
    return service.trending({ userId: req.user?.id });
  });
};
