import { prisma } from '../../lib/prisma.js';

export type AuditActor =
  | { role: 'admin'; id: string }
  | { role: 'academy'; id: string; groupId?: string | null; academyId?: string | null }
  | { role: 'staff'; id: string; groupId?: string | null; academyId?: string | null }
  | { role: 'system' };

// Mandatory internal control: every state-changing action by an operator writes one AuditLog
// row. `before`/`after` are stored inside `meta` so a reviewer can see exactly what changed.
// `tx` is a Prisma transaction client (or the base client). Typed loosely so it accepts both.
//
// TWO CALLING FORMS, and the old one is unchanged on purpose:
//   writeAudit({ adminId, ... })   — every existing Ops Console call site, untouched.
//   writeAudit({ actor, ... })     — academy-side writers, via lib/audit-actor.ts.
// `adminId` is retained rather than renamed because ~29 admin call sites pass it and the
// [adminId, createdAt] index depends on it.
export async function writeAudit(
  args: {
    adminId?: string;
    actor?: AuditActor;
    action: string;
    targetType: string;
    targetId: string;
    before?: unknown;
    after?: unknown;
    extra?: Record<string, unknown>;
  },
  // biome-ignore lint/suspicious/noExplicitAny: Prisma tx client type is not exported cleanly.
  tx: any = prisma,
) {
  const meta: Record<string, unknown> = {};
  if (args.before !== undefined) meta.before = args.before;
  if (args.after !== undefined) meta.after = args.after;
  if (args.extra) Object.assign(meta, args.extra);

  const actor: AuditActor = args.actor ?? { role: 'admin', id: args.adminId ?? '' };
  const scoped = actor.role === 'academy' || actor.role === 'staff' ? actor : null;

  return tx.auditLog.create({
    data: {
      // Only an admin actor populates the legacy column, so the Ops Console's existing
      // [adminId, createdAt] queries keep returning exactly the rows they did before and are
      // not diluted by academy-side activity.
      adminId: actor.role === 'admin' ? actor.id : null,
      actorId: actor.role === 'system' ? SYSTEM_ACTOR_ID : actor.id,
      actorRole: actor.role,
      groupId: scoped?.groupId ?? null,
      academyId: scoped?.academyId ?? null,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      meta: Object.keys(meta).length ? meta : undefined,
    },
  });
}

// Matches the marker the cron workers already write into the four bare-String actor columns
// (workers/session-close.ts), so "who marked this?" resolves the same way everywhere.
export const SYSTEM_ACTOR_ID = 'system';
