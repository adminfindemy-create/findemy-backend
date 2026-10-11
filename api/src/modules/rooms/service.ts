import crypto from 'crypto';
import { AppError } from '../../lib/app-error.js';
import { env } from '../../lib/env.js';
import { sessionDateIST } from '../../lib/ist.js';
import { prisma } from '../../lib/prisma.js';
import * as attendanceRepo from '../attendance/repo.js';
import * as repo from './repo.js';
import type { BatchScope } from '../../lib/scope.js';
import { learnerIdFromStudentRef, resolveLearner } from '../../lib/learner-access.js';

type RoomToken = {
  token: string;
  room_id: string;
  room_name: string;
};

// Exported so the workshops module can mint a HOST token for the teacher conducting one,
// rather than duplicating the signing logic.
export async function generateHmsToken(roomId: string, userId: string, role: string): Promise<string> {
  // Gate on the management token (the credential the call actually uses). Absent → mock.
  if (!env.HMS_MANAGEMENT_TOKEN) return 'mock-token';

  // 100ms Management API: create auth token
  const res = await fetch('https://api.100ms.live/v2/auth-token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.HMS_MANAGEMENT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      room_id: roomId,
      user_id: userId,
      role,
    }),
  });
  if (!res.ok) return 'mock-token';
  const data: any = await res.json();
  return data.token ?? 'mock-token';
}

// S3.3: create a real 100ms room via the Management API. Null when keys absent (mock).
async function createHmsRoom(name: string): Promise<string | null> {
  if (!env.HMS_MANAGEMENT_TOKEN || !env.HMS_TEMPLATE_ID) return null;
  const res = await fetch('https://api.100ms.live/v2/rooms', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.HMS_MANAGEMENT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, template_id: env.HMS_TEMPLATE_ID }),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  return data.id ?? null;
}

// S3.3: the batch's 100ms room id, provisioned lazily (race-guarded). Falls back to the
// batch id as a mock room when 100ms isn't configured, so the (mock) flow still works.
export async function ensureLiveRoom(batchId: string): Promise<string> {
  const batch = await repo.getBatch(batchId);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.liveRoomId) return batch.liveRoomId;
  const created = await createHmsRoom(`batch-${batchId}`);
  if (!created) return batchId; // mock / no keys
  return repo.setLiveRoomIdIfNull(batchId, created);
}

export async function getBatchToken(batchId: string, userId: string, learnerId?: string): Promise<RoomToken> {
  // The room peer is the LEARNER, so the join webhook marks the right child present.
  const learner = await resolveLearner(userId, learnerId);
  const enrollment = await repo.findEnrollment(batchId, learner.id);
  if (!enrollment) {
    throw new AppError('NOT_ENROLLED', 403, 'You are not enrolled in this batch');
  }

  // S2.1: live-class room is keyed off the batch (slots retired); "live" = a timing is happening now.
  const liveBatch = await repo.findLiveBatch(batchId);
  if (!liveBatch) {
    throw new AppError('NOT_IN_SESSION', 403, 'Class is not live yet');
  }

  const roomId = await ensureLiveRoom(batchId);
  const roomName = enrollment.batch.title;
  const token = await generateHmsToken(roomId, learner.id, 'guest');

  return { token, room_id: roomId, room_name: roomName };
}

// S3.3: academy "Start live class" — host token for the batch's room (academies aren't
// enrolled, so this is separate from the student getBatchToken path).
export async function startLiveClass(
  scope: BatchScope,
  batchId: string,
  actorId: string,
): Promise<RoomToken> {
  // Scoped rather than the old `batch.academyId !== academyId` compare, so a teacher cannot
  // host a live class for a batch they do not teach.
  const batch = await repo.getBatchInScope(batchId, scope);
  if (!batch) {
    throw new AppError('NOT_FOUND', 404, 'Batch not found');
  }
  const roomId = await ensureLiveRoom(batchId);
  // The host identity is the LOGIN, not the branch: with several logins per brand, a branch id
  // here would make every host indistinguishable in the room.
  const token = await generateHmsToken(roomId, actorId, 'host');
  return { token, room_id: roomId, room_name: batch.title };
}

// S3.3: 100ms webhook → real-join attendance. On a verified peer join we resolve (batch,user)
// and write present — server-authoritative, so opening-and-leaving doesn't mark anyone.
export async function handleHmsWebhook(
  body: Record<string, any>,
  signature: string,
  rawBody?: string,
): Promise<{ received: boolean }> {
  const secret = env.HMS_WEBHOOK_SECRET || '';
  if (secret) {
    const payload = rawBody ?? JSON.stringify(body);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid webhook signature');
    }
  }

  if (body.type !== 'peer.join.success') return { received: true };
  const data = (body.data ?? {}) as Record<string, any>;
  const roomId = data.room_id as string | undefined;
  const userId = (data.user_id ?? data.peer?.user_id) as string | undefined;
  if (!roomId || !userId) return { received: true };

  const batch = await repo.findBatchByLiveRoomId(roomId);
  if (!batch) return { received: true };

  // An online join is the same kind of fact as a QR scan, so it records the session too —
  // otherwise the closer would never see online sessions and no online absence would be written.
  // The peer id is a learner id; tokens issued before family profiles carry the account's user id,
  // which maps to that account's own learner.
  const learnerId = await learnerIdFromStudentRef({ user_id: userId });
  const enrollment = await repo.findEnrollment(batch.id, learnerId);
  if (!enrollment) return { received: true };

  const sessionDate = sessionDateIST();
  await prisma.$transaction(async (tx) => {
    await attendanceRepo.ensureClassSession(batch.id, sessionDate, tx);
    await attendanceRepo.recordPresent(enrollment, batch.id, sessionDate, 'auto', tx);
  });
  return { received: true };
}

export async function getWorkshopToken(workshopId: string, userId: string): Promise<RoomToken> {
  const registration = await repo.findWorkshopRegistration(workshopId, userId);
  if (!registration || registration.status !== 'confirmed') {
    throw new AppError('NOT_REGISTERED', 403, 'You are not registered for this workshop');
  }

  const workshop = registration.workshop;
  if (workshop.type !== 'online') {
    throw new AppError('NOT_ONLINE', 400, 'This workshop is not online');
  }

  const now = new Date();
  const startAt = new Date(workshop.startAt);
  const windowStart = new Date(startAt.getTime() - 10 * 60 * 1000);
  const windowEnd = new Date(startAt.getTime() + workshop.durationMin * 60 * 1000);

  if (now < windowStart || now > windowEnd) {
    throw new AppError('NOT_IN_SESSION', 403, 'Workshop is not live yet');
  }

  const roomId = workshop.id;
  const token = await generateHmsToken(roomId, userId, 'student');

  return { token, room_id: roomId, room_name: workshop.title };
}
