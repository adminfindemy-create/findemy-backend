import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { env } from '../lib/env.js';

// The mobile apps are native (React Native / Expo) and send no browser `Origin` header, so
// tightening CORS does not affect them — it only governs browser callers. The Ops Console is a
// browser SPA, so we lock the allowed set to its configured origin (+ localhost in dev), instead
// of the previous reflect-everything `origin: true`.
const allowedOrigins = new Set(
  [env.OPS_CONSOLE_ORIGIN, env.WEB_ORIGIN].filter((s): s is string => !!s),
);

function isLocalhost(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export const corsPlugin = fp(async (app: FastifyInstance) => {
  await app.register(cors, {
    origin(origin, cb) {
      // No Origin header → non-browser client (native apps, curl, server-to-server): allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      // Any localhost port during development (Expo web, Vite, etc.).
      if (env.NODE_ENV !== 'production' && isLocalhost(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  });
});
