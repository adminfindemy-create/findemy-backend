import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          fields: err.fields,
        },
      });
    }

    // Zod validation errors (from schema.parse in route handlers) → 400.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ZodError') {
      const issues = (err as { issues?: Array<{ path?: (string | number)[]; message?: string }> }).issues ?? [];
      const fields: Record<string, string> = {};
      let firstMessage = 'Validation failed';
      for (const issue of issues) {
        const key = issue.path?.join('.') || 'unknown';
        fields[key] = issue.message ?? 'Invalid';
        if (firstMessage === 'Validation failed' && issue.message) firstMessage = issue.message;
      }
      return reply.status(400).send({ error: { code: 'VALIDATION', message: firstMessage, fields } });
    }

    const validation =
      err && typeof err === 'object' && 'validation' in err
        ? (err as { validation?: unknown }).validation
        : undefined;
    if (validation) {
      const fields: Record<string, string> = {};
      for (const issue of validation as Array<{
        path?: string;
        message?: string;
      }>) {
        const key = issue.path ?? 'unknown';
        fields[key] = issue.message ?? 'Invalid';
      }
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Validation failed',
          fields,
        },
      });
    }

    // Fastify-native errors that carry an explicit client-error status (e.g. the
    // 429 from @fastify/rate-limit on /public/*, 413 payload-too-large) — pass the
    // status + code through instead of collapsing everything to a generic 500.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: (err as { code?: string }).code ?? 'ERROR',
          message: (err as { message?: string }).message || 'Request error',
        },
      });
    }

    logger.error({ err }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Internal server error',
      },
    });
  });
});
