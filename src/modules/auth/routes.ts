import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const RequestOtpSchema = z.object({
  phone: z.string().min(1),
  role: z.enum(['student', 'academy']),
});

const VerifyOtpSchema = z.object({
  otp_id: z.string().min(1),
  code: z.string().min(1),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1),
});

const LogoutSchema = z.object({
  refresh_token: z.string().min(1),
});

const OnboardingSchema = z.object({
  name: z.string().min(1),
  age: z.number().optional(),
  location: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  interests: z.array(z.enum(['music', 'dance', 'arts', 'yoga'])),
});

const InterestsSchema = z.object({
  interests: z.array(z.enum(['music', 'dance', 'arts', 'yoga'])),
});

const OAuthLoginSchema = z.object({
  idToken: z.string().min(1),
  nonce: z.string().min(1).optional(),
  role: z.enum(['student', 'academy']),
});

const AcademyOnboardingSchema = z.object({
  ownerName: z.string().min(1).optional(),
  academyName: z.string().min(1),
  city: z.string().min(1),
  category: z.enum(['music', 'dance', 'arts', 'yoga']),
  phone: z.string().min(1).optional(),
  // S0.3: academy's offered delivery modes + tagline.
  modesOffered: z.array(z.enum(['in_studio', 'online', 'home_visit'])).optional(),
  tagline: z.string().max(120).optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/otp/request', async (req) => {
    const body = RequestOtpSchema.parse(req.body);
    return service.requestOtp(body);
  });

  app.post('/auth/otp/verify', async (req) => {
    const body = VerifyOtpSchema.parse(req.body);
    return service.verifyOtp(body);
  });

  app.post('/auth/oauth/apple', async (req) => {
    const body = OAuthLoginSchema.parse(req.body);
    return service.loginWithOAuth({ provider: 'apple', ...body });
  });

  app.post('/auth/oauth/google', async (req) => {
    const body = OAuthLoginSchema.parse(req.body);
    return service.loginWithOAuth({ provider: 'google', ...body });
  });

  app.post('/auth/refresh', async (req) => {
    const body = RefreshSchema.parse(req.body);
    return service.refresh({ refreshToken: body.refresh_token });
  });

  app.post('/auth/logout', { preHandler: app.requireAuth() }, async (req) => {
    const body = LogoutSchema.parse(req.body);
    await service.logout({ refreshToken: body.refresh_token });
    return {};
  });

  app.get('/me', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getMe({ userId: req.user.id });
  });

  app.get('/me/stats', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getMyStats({ userId: req.user.id });
  });

  app.put('/me/onboarding', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = OnboardingSchema.parse(req.body);
    return service.updateOnboarding({ userId: req.user.id, ...body });
  });

  app.put('/me/interests', { preHandler: app.requireAuth('student') }, async (req) => {
    const body = InterestsSchema.parse(req.body);
    return service.updateInterests({ userId: req.user.id, ...body });
  });

  app.get('/me/enrollments', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getMyEnrollments({ userId: req.user.id });
  });

  // S3.1: Classes tab — enrolled batches only (active + past), no trials.
  app.get('/me/classes', { preHandler: app.requireAuth('student') }, async (req) => {
    return service.getMyClasses({ userId: req.user.id });
  });

  app.post(
    '/academy/onboarding',
    { preHandler: app.requireAuth('academy') },
    async (req) => {
      const body = AcademyOnboardingSchema.parse(req.body);
      return service.completeAcademyOnboarding({
        accountId: req.user.id,
        ...body,
      });
    },
  );
};
