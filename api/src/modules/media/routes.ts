import type { FastifyPluginAsync } from 'fastify';
import { readLocalMedia } from '../../lib/media-storage.js';

// Serves locally-stored media (dev fallback when cloud storage isn't configured). Public — media
// must be viewable without auth. In production with S3, media URLs point at the bucket instead.
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.get('/uploads/*', async (req, reply) => {
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    const file = await readLocalMedia(rel);
    if (!file) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Media not found' } });
    reply.header('Content-Type', file.contentType);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(file.buffer);
  });
};
