/**
 * The only way an academy-side route writes an audit row.
 *
 * It takes the REQUEST, never loose ids, and that is the whole point: an actor derived from
 * `req.user` cannot be forged by a service that read an id out of a request body. Nothing
 * outside this file should hand-assemble an `AuditActor` for an academy-side write.
 *
 * See ai-usage/final-app/plan/academy-staff-roles.md §8.
 */
import type { FastifyRequest } from 'fastify';
import { writeAudit, type AuditActor } from '../modules/admin/audit.js';

export function actorFromRequest(req: FastifyRequest): AuditActor {
  if (req.user.role === 'admin') return { role: 'admin', id: req.user.id };
  return {
    // `sub_kind` names the table `req.user.id` points at. Defaulting to 'academy' matches the
    // guard, where an absent sub_kind means an owner.
    role: req.user.sub_kind === 'staff' ? 'staff' : 'academy',
    id: req.user.id,
    // Denormalised onto the row so an owner's activity log is one indexed read.
    groupId: req.user.group_id ?? null,
    academyId: req.user.academy_id ?? null,
  };
}

export async function writeStaffAudit(
  req: FastifyRequest,
  args: {
    action: string;
    targetType: string;
    targetId: string;
    before?: unknown;
    after?: unknown;
    extra?: Record<string, unknown>;
  },
  // biome-ignore lint/suspicious/noExplicitAny: Prisma tx client type is not exported cleanly.
  tx?: any,
) {
  return writeAudit({ ...args, actor: actorFromRequest(req) }, tx);
}
