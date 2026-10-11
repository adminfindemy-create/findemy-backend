import { AppError } from '../../lib/app-error.js';
import * as pushRepo from '../push/repo.js';
import { sendBroadcast } from '../push/service.js';
import { writeAudit } from './audit.js';

export type Segment = 'students' | 'academies' | 'all';

const SEGMENT_ROLES: Record<Segment, ('student' | 'academy')[]> = {
  students: ['student'],
  academies: ['academy'],
  all: ['student', 'academy'],
};

// Audience preview: how many devices / distinct subjects a segment would reach right now.
export async function audience(segment: Segment) {
  const tokens = await pushRepo.findTokensForRoles(SEGMENT_ROLES[segment]);
  return { segment, devices: tokens.length, subjects: new Set(tokens.map((t) => t.subjectId)).size };
}

// Send a push to everyone in the segment. Audited with the copy + reach.
export async function broadcast(actorId: string, input: { segment: Segment; title: string; body: string }) {
  const roles = SEGMENT_ROLES[input.segment];
  if (!roles) throw new AppError('BAD_REQUEST', 400, 'Invalid segment');

  const result = await sendBroadcast({ roles, title: input.title, body: input.body, data: { type: 'broadcast' } });

  await writeAudit({
    adminId: actorId,
    action: 'broadcast.send',
    targetType: 'Broadcast',
    targetId: input.segment,
    extra: {
      segment: input.segment,
      title: input.title,
      body: input.body,
      recipients: result.recipients,
      subjects: result.subjects,
      sent: result.sent,
    },
  });

  return result;
}
