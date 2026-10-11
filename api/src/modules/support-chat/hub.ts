import type { WebSocket } from '@fastify/websocket';

// In-memory WebSocket hub for real-time support chat (#1). Single Fastify process, so a module-level
// registry is sufficient. Clients connect to /ws/support (delivery-only); they POST messages over
// REST and receive live updates here. Admins receive every conversation's events.
export type HubRole = 'user' | 'academy' | 'admin';

type Client = { role: HubRole; id: string; socket: WebSocket };

const clients = new Set<Client>();

export function addClient(client: Client): void {
  clients.add(client);
}

export function removeClient(client: Client): void {
  clients.delete(client);
}

// Deliver a payload to every connected participant of a conversation: the owning user/academy
// and all admins. An academy client registers under its GROUP id, not a branch, because the
// support inbox is group-wide (plan §5) — so `conv` must carry the branch's `groupId`.
export function broadcast(
  conv: { userId?: string | null; academyId?: string | null; groupId?: string | null },
  payload: unknown,
): void {
  const json = JSON.stringify(payload);
  for (const c of clients) {
    const isParticipant =
      c.role === 'admin' ||
      (c.role === 'user' && !!conv.userId && c.id === conv.userId) ||
      (c.role === 'academy' && !!conv.groupId && c.id === conv.groupId);
    if (!isParticipant) continue;
    try {
      c.socket.send(json);
    } catch {
      // Dead socket; it will be cleaned up on close.
    }
  }
}
