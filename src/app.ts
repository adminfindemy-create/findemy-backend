import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { logger } from './lib/logger.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { corsPlugin } from './plugins/cors.js';
import { authPlugin } from './plugins/auth.js';
import { mockPlugin } from './plugins/mock.js';
import { registerRoutes } from './routes.js';

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
  });

  await app.register(errorHandlerPlugin);
  await app.register(corsPlugin);
  await app.register(authPlugin);
  await app.register(mockPlugin);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB
  // Fastify v5: an instance built with a custom `loggerInstance` (pino Logger)
  // doesn't structurally unify with the plain `FastifyInstance`
  // (FastifyBaseLogger) that registerRoutes annotates. Same instance at runtime.
  await registerRoutes(app as unknown as FastifyInstance);

  app.get('/health', async () => {
    return { ok: true, version: process.env.GIT_SHA || 'dev', uptime_s: process.uptime() };
  });

  return app;
}
