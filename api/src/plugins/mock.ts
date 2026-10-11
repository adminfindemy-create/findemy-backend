import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { mockHandlers } from '../mock/fixtures.js';

export const mockPlugin = fp(async (app: FastifyInstance) => {
  // Live per-request check on `process.env.MOCK` — NOT the import-time `env.MOCK`
  // const. Tests set process.env.MOCK *after* modules import (getTestApp), so a
  // cached check would never activate. Registering the hook unconditionally and
  // checking per request lets getTestApp() opt in (MOCK='1') while other test
  // files stay on the real path (MOCK='0').
  app.addHook('preHandler', async (req, reply) => {
    if (process.env.MOCK !== '1') return;
    // Prefer the matched route pattern (no query, no params replaced) when
    // Fastify exposes it. Fall back to the raw URL with the query string
    // stripped — otherwise lookups like `GET-academies?sort=distance` never
    // resolve and authenticated routes 401 in mock mode.
    const routePattern =
      (req as { routerPath?: string }).routerPath ??
      (req as { routeOptions?: { url?: string } }).routeOptions?.url;
    const rawPath = routePattern ?? req.url.split('?')[0];
    const path = rawPath.replace(/^\//, '');
    const key = `${req.method}-${path}`
      .replace(/:/g, '_')
      .replace(/\//g, '-');

    const handler = mockHandlers[key] || mockHandlers[rawPath];
    if (handler) {
      const result = await handler(req);
      return reply.send(result);
    }
  });
});
