/**
 * `GET /studio/audit` — the owner's record of who did what.
 *
 * Owner-only (`audit.view`). The rationale is the one already written into the schema for the
 * single admin role: while roles are coarse, an immutable record of who did what IS the
 * primary control.
 *
 * ⚠️ Deliberately NOT merged into `GET /studio/activity`. That is a STUDENT-event feed ("a
 * student enrolled"); conflating it with "a manager deleted a batch" is how audit trails become
 * unreadable.
 */
import { prisma } from '../../lib/prisma.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { resolveActors } from '../../lib/actor.js';

const PAGE = 30;

export async function getAuditLog(groupId: string, cursor?: string) {
  const c = cursor ? decodeCursor(cursor) : null;

  const rows = await prisma.auditLog.findMany({
    where: {
      groupId,
      // Keyset pagination on (createdAt, id): `id` breaks the tie so two rows written in the
      // same millisecond cannot be skipped or repeated across pages.
      ...(c
        ? {
            OR: [
              { createdAt: { lt: new Date(c.ts) } },
              { createdAt: new Date(c.ts), id: { lt: c.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE + 1,
  });

  const hasMore = rows.length > PAGE;
  const page = hasMore ? rows.slice(0, PAGE) : rows;
  const actors = await resolveActors(page.map((r) => r.actorId));

  return {
    items: page.map((r) => ({
      id: r.id,
      action: r.action,
      target_type: r.targetType,
      target_id: r.targetId,
      actor: actors.get(r.actorId) ?? { id: r.actorId, name: 'Unknown', kind: 'unknown' },
      actor_role: r.actorRole,
      academy_id: r.academyId,
      meta: r.meta,
      created_at: r.createdAt.toISOString(),
    })),
    next_cursor:
      hasMore && page.length
        ? encodeCursor({ id: page[page.length - 1].id, ts: page[page.length - 1].createdAt.toISOString() })
        : null,
  };
}
