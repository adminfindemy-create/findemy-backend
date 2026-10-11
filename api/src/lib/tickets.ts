import { AppError } from './app-error.js';
import { prisma } from './prisma.js';
import { resolveLearner } from './learner-access.js';

// Multi-ticket workshop / event bookings. A registration is one per account per item and
// carries `quantity` tickets, one attendee row per ticket:
//   - workshops, meetups and workshop-type events: named tickets for the holder and friends;
//   - competitions: participants, each a learner on the family account (parent, child or both).
// Old app builds send no attendees and get one ticket for the account holder.

/** Most tickets (or participants) one booking can hold. */
export const MAX_TICKETS = 6;
const MAX_NAME = 60;

export type AttendeeInput = { name?: unknown };

export type ResolvedAttendee = { name: string; position: number; learnerId?: string | null };

/**
 * Named tickets for a workshop or meetup. The first ticket is the account holder's: an empty or
 * missing first name falls back to the account name. `maxTickets` is 1 for online sessions,
 * which only the account holder can join.
 */
export async function resolveTicketAttendees(
  userId: string,
  input: AttendeeInput[] | undefined,
  maxTickets: number,
): Promise<ResolvedAttendee[]> {
  const list = Array.isArray(input) && input.length ? input : [{}];
  if (list.length > maxTickets) {
    throw new AppError(
      'TOO_MANY_TICKETS',
      400,
      maxTickets === 1 ? 'Online sessions are booked one ticket at a time' : `You can book up to ${maxTickets} tickets`,
    );
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return list.map((a, i) => {
    const raw = typeof a?.name === 'string' ? a.name.trim() : '';
    const name = raw || (i === 0 ? (user?.name ?? '').trim() : '');
    if (!name) throw new AppError('VALIDATION', 400, `Enter a name for ticket ${i + 1}`);
    if (name.length > MAX_NAME) throw new AppError('VALIDATION', 400, `Ticket ${i + 1}: name is too long`);
    return { name, position: i };
  });
}

/**
 * Competition participants: learners on this account. No ids → the account holder. Each learner
 * may hold only one live entry per competition, whoever on the family registered them.
 */
export async function resolveCompetitionParticipants(
  userId: string,
  eventId: string,
  learnerIds: unknown,
  ownRegistrationId?: string,
): Promise<ResolvedAttendee[]> {
  const ids = Array.isArray(learnerIds)
    ? [...new Set(learnerIds.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    : [];
  if (ids.length > MAX_TICKETS) {
    throw new AppError('TOO_MANY_TICKETS', 400, `You can enter up to ${MAX_TICKETS} participants`);
  }
  const learners = ids.length
    ? await Promise.all(ids.map((id) => resolveLearner(userId, id)))
    : [await resolveLearner(userId, null)];

  const taken = await prisma.eventAttendee.findMany({
    where: {
      learnerId: { in: learners.map((l) => l.id) },
      registration: {
        eventId,
        status: { not: 'cancelled' },
        ...(ownRegistrationId ? { id: { not: ownRegistrationId } } : {}),
      },
    },
    select: { learner: { select: { name: true } } },
  });
  if (taken.length) {
    const who = taken[0].learner?.name || 'This participant';
    throw new AppError('ALREADY_REGISTERED', 409, `${who} is already registered for this competition`);
  }

  return learners.map((l, i) => ({ name: l.name || 'Participant', position: i, learnerId: l.id }));
}

/** API shape of one attendee. */
export function serializeAttendee(a: { name: string; position: number; learnerId?: string | null }) {
  return { name: a.name, position: a.position, learner_id: a.learnerId ?? null };
}
