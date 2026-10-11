import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { NOTE_MAX_BYTES } from '../../lib/media-storage.js';
import * as service from './service.js';
import { batchScope } from '../../lib/scope.js';

// Class notes. Academy writes, enrolled students read. Attachments are NEVER publicly served —
// they stream through GET /me/notes/:fileId/file behind the eligibility check.

const NoteBodySchema = z.object({
  // Empty string clears the text; the service still enforces "body or a file".
  body: z.string().max(4000).nullish(),
});

function mbLabel(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export const classNoteRoutes: FastifyPluginAsync = async (app) => {
  // ─── Academy ───────────────────────────────────────────────────────────────

  app.get('/studio/batches/:id/notes', { preHandler: app.requireAuth('academy', 'notes.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const { date } = req.query as { date?: string };
    return service.getNoteForSession(batchScope(req.user, 'notes.view'), id, date);
  });

  // Upsert the note. JSON `{ body }` sets the text; a multipart request appends one file
  // (with an optional `body` field alongside).
  app.post('/studio/batches/:id/notes', { preHandler: app.requireAuth('academy', 'notes.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const { date } = req.query as { date?: string };

    if (req.isMultipart()) {
      const data = await req.file();
      if (!data) throw new AppError('VALIDATION', 400, 'No file uploaded');
      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch {
        // @fastify/multipart aborts the stream at the global fileSize cap. Name the real limit —
        // a silent 413 is how teachers quietly abandon a feature.
        throw new AppError(
          'VALIDATION',
          400,
          `That file is over ${mbLabel(NOTE_MAX_BYTES)}. Notes must be under ${mbLabel(NOTE_MAX_BYTES)} — try scanning at a lower quality.`,
        );
      }
      const bodyField = (data.fields as Record<string, { value?: unknown } | undefined>)?.body;
      const bodyValue = typeof bodyField?.value === 'string' ? bodyField.value : undefined;
      return service.saveNote({
        scope: batchScope(req.user, 'notes.manage'),
        accountId: req.user.id,
        batchId: id,
        dateStr: date,
        body: bodyValue,
        file: {
          buffer,
          mimeType: data.mimetype,
          fileName: data.filename || 'attachment',
        },
      });
    }

    const parsed = NoteBodySchema.parse(req.body ?? {});
    return service.saveNote({
      scope: batchScope(req.user, 'notes.manage'),
      accountId: req.user.id,
      batchId: id,
      dateStr: date,
      body: parsed.body ?? null,
    });
  });

  app.delete('/studio/notes/files/:fileId', { preHandler: app.requireAuth('academy', 'notes.manage') }, async (req) => {
    const { fileId } = req.params as { fileId: string };
    return service.deleteNoteFile(batchScope(req.user, 'notes.manage'), fileId);
  });

  app.delete('/studio/batches/:id/notes', { preHandler: app.requireAuth('academy', 'notes.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const { date } = req.query as { date?: string };
    return service.deleteNoteForSession(batchScope(req.user, 'notes.manage'), id, date);
  });

  // ─── Student ───────────────────────────────────────────────────────────────

  app.get('/me/enrollments/:id/notes', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.listNotesForStudent(req.user.id, id);
  });

  app.post('/me/enrollments/:id/notes/seen', { preHandler: app.requireAuth('student') }, async (req) => {
    const { id } = req.params as { id: string };
    return service.markNotesSeen(req.user.id, id);
  });

  // The gated byte stream. Private storage + this check are what make the eligibility rules real.
  app.get('/me/notes/:fileId/file', { preHandler: app.requireAuth('student') }, async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    const file = await service.readNoteFileForStudent(req.user.id, fileId);
    reply.header('Content-Type', file.contentType);
    // Entitlement can be revoked, so this must never be cached by a shared cache.
    reply.header('Cache-Control', 'private, no-store');
    reply.header(
      'Content-Disposition',
      `inline; filename="${file.fileName.replace(/["\\]/g, '')}"`,
    );
    return reply.send(file.buffer);
  });
};
