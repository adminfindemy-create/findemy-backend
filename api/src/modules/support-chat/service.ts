import type { SupportParty, SupportSenderRole, SupportConversation, SupportMessage } from '@prisma/client';
import type { AuthUser } from '../../types.js';
import { AppError } from '../../lib/app-error.js';
import { sendPushNotifications } from '../push/service.js';
import * as repo from './repo.js';
import { broadcast } from './hub.js';

// ---------- serialization ----------

function serializeConversation(c: SupportConversation) {
  return {
    id: c.id,
    party: c.party,
    user_id: c.userId,
    academy_id: c.academyId,
    subject: c.subject,
    status: c.status,
    created_at: c.createdAt.toISOString(),
    last_message_at: c.lastMessageAt.toISOString(),
  };
}

function serializeMessage(m: SupportMessage) {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    sender_role: m.senderRole,
    sender_id: m.senderId,
    body: m.body,
    attachment_urls: m.attachmentUrls,
    created_at: m.createdAt.toISOString(),
  };
}

// ---------- helpers ----------

// The party + owner id for a non-admin requester.
function partyFor(user: AuthUser): { party: SupportParty; ownerId: string; senderRole: SupportSenderRole } {
  if (user.role === 'academy') {
    // The BRAND owns academy support, not the active branch — every login in a group sees and
    // can answer every branch's tickets, regardless of `X-Branch-Id` (plan §5).
    if (!user.group_id) throw new AppError('FORBIDDEN', 403, 'No academy linked to this account');
    return { party: 'academy', ownerId: user.group_id, senderRole: 'academy' };
  }
  if (user.role === 'student') {
    return { party: 'student', ownerId: user.id, senderRole: 'user' };
  }
  throw new AppError('FORBIDDEN', 403, 'Unsupported role for support chat');
}

// Assert the requester may access this conversation; returns the sender role to stamp on messages.
async function assertAccess(user: AuthUser, conv: SupportConversation): Promise<SupportSenderRole> {
  if (user.role === 'admin') return 'admin';
  const { party, ownerId, senderRole } = partyFor(user);
  // For the academy party `ownerId` is a group id and `conv.academyId` is a branch id, so
  // ownership is "this branch belongs to my brand" — one hop, not an equality check.
  const owns =
    party === 'student'
      ? conv.userId === ownerId
      : !!conv.academyId && (await repo.branchBelongsToGroup(conv.academyId, ownerId));
  if (conv.party !== party || !owns) throw new AppError('FORBIDDEN', 403, 'Not your conversation');
  return senderRole;
}

// After a message lands, deliver it live and (for admin replies) push to the mobile owner.
async function fanOut(conv: SupportConversation, message: SupportMessage) {
  const groupId = conv.academyId ? await repo.groupIdForBranch(conv.academyId) : null;
  broadcast(
    { ...conv, groupId },
    { type: 'message', conversation_id: conv.id, message: serializeMessage(message) },
  );
  if (message.senderRole === 'admin') {
    const target =
      conv.party === 'student'
        ? { subjectId: conv.userId, subjectRole: 'student' as const }
        : { subjectId: conv.academyId, subjectRole: 'academy' as const };
    if (target.subjectId) {
      await sendPushNotifications({
        subjectId: target.subjectId,
        subjectRole: target.subjectRole,
        title: 'Findemy Support',
        body: message.body.slice(0, 120),
        data: { type: 'support_message', conversation_id: conv.id },
      }).catch(() => undefined);
    }
  }
}

// ---------- participant (student / academy) ----------

export async function listMyConversations(user: AuthUser) {
  const { party, ownerId } = partyFor(user);
  const conversations = await repo.listConversationsFor(party, ownerId);
  return { conversations: conversations.map(serializeConversation) };
}

export async function createConversation(
  user: AuthUser,
  input: { subject?: string; body: string; attachment_urls?: string[] },
) {
  const { party, ownerId, senderRole } = partyFor(user);
  const conv = await repo.createConversation({
    party,
    userId: party === 'student' ? ownerId : null,
    // The ticket is filed AGAINST a branch (that is what it is about) even though the whole
    // group can see and answer it — hence the active branch here, not `ownerId`.
    academyId: party === 'academy' ? (user.academy_id ?? null) : null,
    subject: input.subject ?? null,
  });
  const message = await repo.createMessage({
    conversationId: conv.id,
    senderRole,
    senderId: user.id,
    body: input.body,
    attachmentUrls: input.attachment_urls ?? [],
  });
  await fanOut(conv, message);
  return { conversation: serializeConversation(conv), message: serializeMessage(message) };
}

export async function getMessages(user: AuthUser, conversationId: string) {
  const conv = await repo.getConversation(conversationId);
  if (!conv) throw new AppError('NOT_FOUND', 404, 'Conversation not found');
  await assertAccess(user, conv);
  const messages = await repo.listMessages(conversationId);
  return { conversation: serializeConversation(conv), messages: messages.map(serializeMessage) };
}

export async function postMessage(
  user: AuthUser,
  conversationId: string,
  input: { body: string; attachment_urls?: string[] },
) {
  const conv = await repo.getConversation(conversationId);
  if (!conv) throw new AppError('NOT_FOUND', 404, 'Conversation not found');
  const senderRole = await assertAccess(user, conv);
  // A participant replying to a resolved ticket reopens it.
  let active = conv;
  if (conv.status === 'resolved' && senderRole !== 'admin') {
    active = await repo.setStatus(conv.id, 'open');
  }
  const message = await repo.createMessage({
    conversationId,
    senderRole,
    senderId: user.id,
    body: input.body,
    attachmentUrls: input.attachment_urls ?? [],
  });
  await fanOut(active, message);
  return { message: serializeMessage(message) };
}

// ---------- admin ----------

export async function adminListConversations(status?: 'open' | 'resolved') {
  const rows = await repo.listAllConversations(status);
  const counts = await repo.conversationCountsByStatus();
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  return {
    conversations: rows.map((c) => ({
      ...serializeConversation(c),
      owner_name: c.party === 'student' ? c.user?.name ?? null : c.academy?.name ?? null,
      owner_contact: c.party === 'student' ? c.user?.phone ?? null : null,
      last_message: c.messages[0]
        ? { body: c.messages[0].body, sender_role: c.messages[0].senderRole, created_at: c.messages[0].createdAt.toISOString() }
        : null,
    })),
    counts: { open: byStatus.open ?? 0, resolved: byStatus.resolved ?? 0 },
  };
}

export async function adminGetMessages(conversationId: string) {
  const conv = await repo.getConversation(conversationId);
  if (!conv) throw new AppError('NOT_FOUND', 404, 'Conversation not found');
  const messages = await repo.listMessages(conversationId);
  return { conversation: serializeConversation(conv), messages: messages.map(serializeMessage) };
}

export async function adminPostMessage(
  adminId: string,
  conversationId: string,
  input: { body: string; attachment_urls?: string[] },
) {
  const conv = await repo.getConversation(conversationId);
  if (!conv) throw new AppError('NOT_FOUND', 404, 'Conversation not found');
  const message = await repo.createMessage({
    conversationId,
    senderRole: 'admin',
    senderId: adminId,
    body: input.body,
    attachmentUrls: input.attachment_urls ?? [],
  });
  await fanOut(conv, message);
  return { message: serializeMessage(message) };
}

export async function adminSetStatus(conversationId: string, status: 'open' | 'resolved') {
  const conv = await repo.getConversation(conversationId);
  if (!conv) throw new AppError('NOT_FOUND', 404, 'Conversation not found');
  const updated = await repo.setStatus(conversationId, status);
  broadcast(updated, { type: 'status', conversation_id: conversationId, status });
  return { conversation: serializeConversation(updated) };
}
