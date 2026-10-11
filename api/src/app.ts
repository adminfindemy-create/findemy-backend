import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
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

  // ── Raw body, for webhook signature verification ────────────────────────────
  //
  // Two routes verify an HMAC over the EXACT bytes a provider sent (Razorpay's
  // `x-razorpay-signature`, 100ms's `x-100ms-signature`). Both were written to read
  // `req.rawBody` and fall back to `JSON.stringify(req.body)` — but nothing ever populated
  // `rawBody`, so the fallback was the only path.
  //
  // Re-serialising a parsed object is NOT the bytes that were signed. It usually matches by
  // luck, because V8 preserves key order and Razorpay sends compact JSON — and then silently
  // stops matching the first time a payload carries a non-ASCII character (a cardholder name,
  // a note), an escaped sequence, or a float that formats differently. The failure mode is a
  // 401 on a real captured payment, i.e. money taken and the enrolment never activated.
  //
  // Keeping the raw string costs one parser. `parseAs: 'string'` hands us the body verbatim;
  // everything downstream still sees `req.body` as the parsed object.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string | Buffer, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      (req as any).rawBody = raw;
      if (raw.length === 0) {
        // Fastify's default treats an empty JSON body as an error; keep that behaviour.
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        (err as any).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  await app.register(errorHandlerPlugin);
  await app.register(corsPlugin);
  await app.register(authPlugin);
  await app.register(mockPlugin);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB
  await app.register(websocket); // real-time support chat (#1): /ws/support
  // Fastify v5: an instance built with a custom `loggerInstance` (pino Logger)
  // doesn't structurally unify with the plain `FastifyInstance`
  // (FastifyBaseLogger) that registerRoutes annotates. Same instance at runtime.
  await registerRoutes(app as unknown as FastifyInstance);

  app.get('/health', async () => {
    return { ok: true, version: process.env.GIT_SHA || 'dev', uptime_s: process.uptime() };
  });

  return app;
}
