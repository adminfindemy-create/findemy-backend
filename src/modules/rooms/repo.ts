import { prisma } from '../../lib/prisma.js';

export async function findEnrollment(batchId: string, userId: string) {
  return prisma.enrollment.findFirst({
    where: { batchId, userId, status: 'active' },
    include: {
      batch: {
        include: { timings: true },
      },
    },
  });
}

// S2.1: "is the batch live now?" derived from its weekly TIMINGS (slots retired).
// Returns the batch if a timing is in its [start − 10m, start + duration] window in IST.
const IST_OFFSET_MIN = 5 * 60 + 30;
const LIVE_PRE_WINDOW_MIN = 10;

export async function findLiveBatch(batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { timings: true },
  });
  if (!batch) return null;

  const ist = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
  const dow = ist.getUTCDay();
  const minutesNow = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  const live = batch.timings.some((timing) => {
    if (timing.dayOfWeek !== dow) return false;
    const [hour, minute] = timing.startTime.split(':').map(Number);
    const start = hour * 60 + minute;
    return minutesNow >= start - LIVE_PRE_WINDOW_MIN && minutesNow <= start + timing.durationMin;
  });
  return live ? batch : null;
}

export async function findWorkshopRegistration(workshopId: string, userId: string) {
  return (prisma as any).workshopRegistration.findUnique({
    where: { workshopId_userId: { workshopId, userId } },
    include: { workshop: true },
  });
}

// ---------- S3.3: 100ms live rooms ----------

export async function getBatch(batchId: string) {
  return prisma.batch.findUnique({
    where: { id: batchId },
    select: { id: true, title: true, liveRoomId: true, academyId: true },
  });
}

// Race-guarded store: only the first writer (liveRoomId still null) wins; everyone returns
// the persisted id, so concurrent first-joiners converge on one room (loser's room is orphaned).
export async function setLiveRoomIdIfNull(batchId: string, roomId: string): Promise<string> {
  await prisma.batch.updateMany({ where: { id: batchId, liveRoomId: null }, data: { liveRoomId: roomId } });
  const b = await prisma.batch.findUnique({ where: { id: batchId }, select: { liveRoomId: true } });
  return b?.liveRoomId ?? roomId;
}

// The webhook maps a 100ms room back to its batch.
export async function findBatchByLiveRoomId(roomId: string) {
  return prisma.batch.findFirst({ where: { liveRoomId: roomId }, select: { id: true } });
}
