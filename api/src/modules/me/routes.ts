import type { FastifyPluginAsync } from 'fastify';
import * as service from './service.js';

export const meRoutes: FastifyPluginAsync = async (app) => {
  // --- Saved academies ---
  app.post('/me/saved-academies/:academyId', { preHandler: app.requireAuth('student') }, async (req) => {
    const { academyId } = req.params as { academyId: string };
    return service.toggleSavedAcademy(req.user.id, academyId);
  });

  app.get('/me/saved-academies', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getSavedAcademies(req.user.id);
  });

  // --- Referral --- (DEFERRED, not MVP — gap-analysis §4. Kept/archived, orphaned in the
  //     student app, no new entry points. Revisit post-MVP. Do NOT delete.)
  app.get('/me/referral', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getReferral(req.user.id);
  });

  app.post('/me/referral/claim', { preHandler: app.requireAuth('student') }, async (req) => {
    const { code } = req.body as { code: string };
    if (!code) throw new Error('code required');
    return service.claimReferral(req.user.id, code);
  });

  app.get('/me/referral/history', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getReferralHistory(req.user.id);
  });

  app.get('/me/reviews', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getMyReviews(req.user.id);
  });

  app.get('/me/workshop-registrations', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getMyWorkshopRegistrations(req.user.id);
  });

  app.get('/me/event-registrations', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getMyEventRegistrations(req.user.id);
  });
};
