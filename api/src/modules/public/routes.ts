import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import * as academyService from '../academies/service.js';
import { ListQuerySchema } from '../academies/routes.js';
import * as eventService from '../events/service.js';
import * as programService from '../programs/service.js';
import * as searchService from '../search/service.js';
import { SuggestQuery } from '../search/routes.js';
import * as workshopService from '../workshops/service.js';

// Fixed catalog categories (mirror of CategoryEnum in @findemy/types). Exposed so the
// public web app + its sitemap share one source of truth.
const CATEGORIES = ['music', 'dance', 'arts', 'yoga'] as const;

/**
 * Unauthenticated read API for the public marketing/discovery web app.
 *
 * These routes reuse the same service layer as the student-authed `/academies` and
 * `/programs` endpoints, but: (a) require no token, (b) are rate-limited per-IP, (c) carry
 * cache headers for CDN/Next.js caching, and (d) strip fields that should not be public
 * (e.g. coach phone numbers). Registered as its own encapsulated plugin so the rate-limit
 * and cache-header hooks apply only to `/public/*`, not the rest of the API.
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  // Scoped to this plugin's routes only (encapsulation). In-memory store is fine for a
  // single instance; swap to the Redis store if the API is horizontally scaled.
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  // Let browsers + any CDN in front cache public reads briefly. Only set when a handler
  // hasn't already chosen its own policy.
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'public, max-age=60, s-maxage=300');
    }
    return payload;
  });

  app.get('/public/academies', async (req) => {
    const query = ListQuerySchema.parse(req.query);
    return academyService.listAcademies(query);
  });

  app.get('/public/academies/:id', async (req) => {
    const { id } = req.params as { id: string };
    // No coach fields need stripping any more: `Coach.phone` is gone entirely (a person's
    // number lives on their StaffAccount), so the authed and public payloads are identical.
    return academyService.getAcademyById(id);
  });

  app.get('/public/academies/:id/reviews', async (req) => {
    const { id } = req.params as { id: string };
    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    return academyService.getAcademyReviews(id, cursor, limit ? Number(limit) : undefined);
  });

  app.get('/public/academies/:id/workshops', async (req) => {
    const { id } = req.params as { id: string };
    // listForAcademy's serialized shape is public-safe (no PII).
    return workshopService.listForAcademy(id);
  });

  // Every workshop across every academy. The per-academy route above only answers "what does
  // THIS branch run"; the web needs the whole catalogue to give workshops listing and detail
  // pages of their own (web_phase4_plan.md §5.3 S2). `serializeGlobal` is the same payload the
  // student app reads — display names only, no PII.
  app.get('/public/workshops', async () => {
    return workshopService.listAll();
  });

  app.get('/public/workshops/:id', async (req) => {
    const { id } = req.params as { id: string };
    return workshopService.getWorkshop(id);
  });

  app.get('/public/programs/:id', async (req) => {
    const { id } = req.params as { id: string };
    // A program is BRAND-level, so `academy_id` says which branch the learner is asking about.
    // It scopes the batches — and therefore the price, seats and schedule — to that location,
    // and 404s if the branch does not actually run this program (plan §1.1).
    const { academy_id } = req.query as { academy_id?: string };
    // Response is already public-safe (no PII).
    return programService.getProgramById(id, academy_id);
  });

  app.get('/public/events', async (req) => {
    const { type } = req.query as { type?: string };
    // serialize() shape is public-safe (no PII).
    return eventService.listEvents(type);
  });

  app.get('/public/events/:id', async (req) => {
    const { id } = req.params as { id: string };
    return eventService.getEvent(id);
  });

  // Type-ahead and the pre-typing panel, unauthenticated. The student routes at
  // `/search/*` stay as they are — those personalise off the signed-in user; these cannot,
  // and say so (web_phase4_plan.md §5.3 S4).
  app.get('/public/search/suggest', async (req) => {
    // Same schema as the student route — one definition of a valid suggest query, including
    // the length cap that stops a type-ahead being used as a bulk export.
    const { q, limit } = SuggestQuery.parse(req.query);
    return searchService.suggest({ q, limit });
  });

  app.get('/public/search/trending', async () => {
    return searchService.trending({});
  });

  app.get('/public/meta/categories', async () => {
    return { categories: CATEGORIES };
  });
};
