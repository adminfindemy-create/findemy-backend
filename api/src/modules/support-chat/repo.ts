import type { SupportParty, SupportStatus, SupportSenderRole, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export function createConversation(data: {
  party: SupportParty;
  userId?: string | null;
  academyId?: string | null;
  subject?: string | null;
}) {
  return prisma.supportConversation.create({ data });
}

// The most recent OPEN conversation for a party owner (used to append to an existing ticket).
export function findOpenConversationFor(party: SupportParty, ownerId: string) {
  return prisma.supportConversation.findFirst({
    // Academy side is GROUP-scoped: an unanswered support message on a branch you are not
    // currently switched to is a lost sale, so the inbox deliberately ignores `X-Branch-Id`
    // (plan §5). `ownerId` is the GROUP id for the academy party.
    where:
      party === 'student'
        ? { party, userId: ownerId, status: 'open' }
        : { party, academy: { groupId: ownerId }, status: 'open' },
    orderBy: { lastMessageAt: 'desc' },
  });
}

export function listConversationsFor(party: SupportParty, ownerId: string) {
  return prisma.supportConversation.findMany({
    where:
      party === 'student'
        ? { party, userId: ownerId }
        : { party, academy: { groupId: ownerId } },
    orderBy: { lastMessageAt: 'desc' },
  });
}

export function getConversation(id: string) {
  return prisma.supportConversation.findUnique({ where: { id } });
}

// Admin inbox: all conversations, optionally filtered by status, with owner name + unread-ish preview.
export function listAllConversations(status?: SupportStatus) {
  return prisma.supportConversation.findMany({
    where: status ? { status } : undefined,
    orderBy: { lastMessageAt: 'desc' },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      academy: { select: { id: true, name: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

export function listMessages(conversationId: string) {
  return prisma.supportMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createMessage(data: {
  conversationId: string;
  senderRole: SupportSenderRole;
  senderId: string;
  body: string;
  attachmentUrls: string[];
}) {
  const [message] = await prisma.$transaction([
    prisma.supportMessage.create({ data }),
    prisma.supportConversation.update({
      where: { id: data.conversationId },
      data: { lastMessageAt: new Date() },
    }),
  ]);
  return message;
}

export function setStatus(id: string, status: SupportStatus) {
  return prisma.supportConversation.update({ where: { id }, data: { status } });
}

export function conversationCountsByStatus() {
  return prisma.supportConversation.groupBy({ by: ['status'], _count: { _all: true } }) as unknown as Promise<
    Array<{ status: SupportStatus; _count: { _all: number } }>
  >;
}

export type ConversationWithPreview = Prisma.SupportConversationGetPayload<{
  include: {
    user: { select: { id: true; name: true; phone: true } };
    academy: { select: { id: true; name: true } };
    messages: { orderBy: { createdAt: 'desc' }; take: 1 };
  };
}>;

// Ownership hop for the academy party: conversations store a BRANCH, but access and the
// inbox are decided at the GROUP level (plan §5).
export async function branchBelongsToGroup(academyId: string, groupId: string) {
  const branch = await prisma.academy.findUnique({
    where: { id: academyId },
    select: { groupId: true },
  });
  return branch?.groupId === groupId;
}

export async function groupIdForBranch(academyId: string) {
  const branch = await prisma.academy.findUnique({
    where: { id: academyId },
    select: { groupId: true },
  });
  return branch?.groupId ?? null;
}
