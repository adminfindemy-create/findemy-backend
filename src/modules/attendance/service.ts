import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { istDateKey, sessionDateIST } from '../../lib/ist.js';
import { signCheckinToken, verifyCheckinToken } from '../../lib/tokens.js';
import * as repo from './repo.js';

type AttendanceRecord = Awaited<ReturnType<typeof repo.getBatchAttendance>>[number];

// Kept for the roster serializer + attendance-serializer.test.
export function serializeAttendance(records: AttendanceRecord[]) {
  return {
    students: records.map((r) => ({
      user_id: r.userId,
      name: r.user.name,
      present: r.present,
    })),
  };
}

// S3.2: academy issues a short-lived QR token for today's in-studio session.
export async function issueCheckinToken(academyId: string, batchId: string) {
  const batch = await prisma.batch.findFirst({
    where: { id: batchId, academyId },
    select: { mode: true, status: true },
  });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.mode !== 'offline') {
    throw new AppError('VALIDATION', 400, 'QR check-in is for in-studio batches only');
  }
  const session_date = istDateKey(new Date());
  const token = await signCheckinToken({ batch_id: batchId, session_date });
  return { token, session_date };
}

// S3.2: student scans the QR → mark present (enrolled + in-studio; idempotent on double-scan).
export async function checkin(userId: string, token: string) {
  let claim: { batch_id: string; session_date: string };
  try {
    claim = await verifyCheckinToken(token);
  } catch {
    throw new AppError('VALIDATION', 400, 'Invalid or expired check-in code');
  }
  const enrollment = await prisma.enrollment.findUnique({
    where: { userId_batchId: { userId, batchId: claim.batch_id } },
    select: { status: true, batch: { select: { mode: true, title: true } } },
  });
  if (!enrollment || enrollment.status !== 'active') {
    throw new AppError('NOT_ENROLLED', 403, 'You are not enrolled in this batch');
  }
  if (enrollment.batch.mode !== 'offline') {
    throw new AppError('VALIDATION', 400, 'This is not an in-studio class');
  }
  await repo.recordPresent(userId, claim.batch_id, sessionDateIST());
  return { present: true, batch_title: enrollment.batch.title };
}

// S3.2/S3.3: live roster — active enrolees split by whether they've a present row today.
export async function getSessionAttendance(batchId: string, dateStr?: string) {
  const date = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : sessionDateIST();
  const [enrollees, records] = await Promise.all([
    repo.getActiveEnrollees(batchId),
    repo.getBatchAttendance(batchId, date),
  ]);
  const present = new Map(records.filter((r) => r.present).map((r) => [r.userId, r.markedAt]));
  const roster = enrollees.map((e) => ({
    user_id: e.userId,
    name: e.user.name,
    checked_in: present.has(e.userId),
    marked_at: present.get(e.userId)?.toISOString(),
  }));
  return {
    present_count: roster.filter((r) => r.checked_in).length,
    total: roster.length,
    roster,
  };
}
