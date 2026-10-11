import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { z } from 'zod';
import { AppError } from '../../lib/app-error.js';
import { verifyAccessToken } from '../../lib/tokens.js';
import { prisma } from '../../lib/prisma.js';
import * as service from './service.js';
import { addClient, removeClient, type HubRole } from './hub.js';

const CreateSchema = z.object({
  subject: z.string().max(120).optional(),
  body: z.string().min(1).max(4000),
  attachment_urls: z.array(z.string().url()).max(6).optional(),
});
const MessageSchema = z.object({
  body: z.string().min(1).max(4000),
  attachment_urls: z.array(z.string().url()).max(6).optional(),
});
const IdParam = z.object({ id: z.string().min(1) });

export const supportChatRoutes: FastifyPluginAsync = async (app) => {
  // ---------- Participant (student / academy) ----------
  app.get('/support/conversations', { preHandler: app.requireAuth() }, async (req) => {
    return service.listMyConversations(req.user);
  });

  app.post('/support/conversations', { preHandler: app.requireAuth() }, async (req) => {
    const body = CreateSchema.parse(req.body);
    return service.createConversation(req.user, body);
  });

  app.get('/support/conversations/:id/messages', { preHandler: app.requireAuth() }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return service.getMessages(req.user, id);
  });

  app.post('/support/conversations/:id/messages', { preHandler: app.requireAuth() }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const body = MessageSchema.parse(req.body);
    return service.postMessage(req.user, id, body);
  });

  // Attachment upload (image) for chat — returns { url }.
  app.post('/support/upload', { preHandler: app.requireAuth() }, async (req) => {
    const data = await req.file();
    if (!data) throw new AppError('VALIDATION', 400, 'No file uploaded');
    const buffer = await data.toBuffer();
    const { storeMedia } = await import('../../lib/media-storage.js');
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    return storeMedia({ keyPrefix: `support/${req.user.role}/${req.user.id}`, buffer, mimeType: data.mimetype, baseUrl });
  });

  // ---------- Admin ----------
  app.get('/admin/support/conversations', { preHandler: app.requireAdmin('support.read') }, async (req) => {
    const { status } = z.object({ status: z.enum(['open', 'resolved']).optional() }).parse(req.query);
    return service.adminListConversations(status);
  });

  app.get('/admin/support/conversations/:id/messages', { preHandler: app.requireAdmin('support.read') }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return service.adminGetMessages(id);
  });

  app.post('/admin/support/conversations/:id/messages', { preHandler: app.requireAdmin('support.write') }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const body = MessageSchema.parse(req.body);
    return service.adminPostMessage(req.user.adminId!, id, body);
  });

  app.post('/admin/support/conversations/:id/resolve', { preHandler: app.requireAdmin('support.write') }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return service.adminSetStatus(id, 'resolved');
  });

  app.post('/admin/support/conversations/:id/reopen', { preHandler: app.requireAdmin('support.write') }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return service.adminSetStatus(id, 'open');
  });

  // ---------- WebSocket (delivery-only): /ws/support?token=<accessToken> ----------
  app.get('/ws/support', { websocket: true }, async (socket: WebSocket, req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }
    let payload: { sub: string; role: string; group_id?: string };
    try {
      payload = await verifyAccessToken(token);
    } catch {
      socket.close(4001, 'Invalid token');
      return;
    }

    let role: HubRole;
    let id: string;
    if (payload.role === 'admin') {
      role = 'admin';
      id = payload.sub;
    } else if (payload.role === 'academy') {
      role = 'academy';
      // The academy participant is the BRAND, not a branch: support is group-scoped, so one
      // socket receives every branch's conversations. Mirror the HTTP auth plugin and prefer
      // the DB over the claim so a regrouped account can't act on the stale brand.
      const account = await prisma.academyAccount.findUnique({
        where: { id: payload.sub },
        select: { groupId: true },
      });
      id = account?.groupId ?? payload.group_id ?? '';
    } else {
      role = 'user';
      id = payload.sub;
    }
    if (!id) {
      socket.close(4003, 'No participant id');
      return;
    }

    const client = { role, id, socket };
    addClient(client);
    socket.on('close', () => removeClient(client));
    socket.on('error', () => removeClient(client));
  });
};
