import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { istWallClockToUtc } from '../../lib/ist.js';
import * as repo from './repo.js';
import { sendPushNotifications } from '../push/service.js';

export async function publishSlots(
  academyId: string,
  data: {
    batch_id: string;
    dates?: string[];
    slots?: { date: string; time: string; capacity?: number }[];
  },
) {
  const batch = await repo.getBatch(data.batch_id, academyId);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  const candidates: { id: string; batchId: string; slotTime: Date; capacity: number }[] = [];

  // Grid mode: explicit per-time slots, each with its own capacity (max trials).
  // The typed time is an IST wall-clock; store the matching UTC instant.
  for (const slotSpec of data.slots ?? []) {
    const [hour, minute] = slotSpec.time.split(':').map(Number);
    candidates.push({
      id: newId(),
      batchId: data.batch_id,
      slotTime: istWallClockToUtc(slotSpec.date, hour ?? 0, minute ?? 0),
      capacity: slotSpec.capacity ?? batch.capacity,
    });
  }

  // Quick mode: whole-day publish derived from the batch's configured timings.
  for (const dateStr of data.dates ?? []) {
    for (const timing of batch.timings) {
      const [hour, minute] = timing.startTime.split(':').map(Number);
      candidates.push({
        id: newId(),
        batchId: data.batch_id,
        slotTime: istWallClockToUtc(dateStr, hour ?? 0, minute ?? 0),
        capacity: batch.capacity,
      });
    }
  }

  // Dedupe by (batch, slotTime): first within this request, then against
  // slots already published for the batch — re-publishing the same dates is
  // a no-op instead of creating duplicate slots.
  const existingSlotMillis = await repo.findExistingSlotMillis(
    data.batch_id,
    candidates.map((candidate) => candidate.slotTime),
  );
  const seenMillis = new Set<number>(existingSlotMillis);
  const slots: typeof candidates = [];
  for (const candidate of candidates) {
    const millis = candidate.slotTime.getTime();
    if (seenMillis.has(millis)) continue;
    seenMillis.add(millis);
    slots.push(candidate);
  }

  if (slots.length > 0) await repo.createSlots(slots);
  return { slots_created: slots.length };
}

export async function deleteSlot(id: string, academyId: string) {
  const slot = await repo.findSlot(id, academyId);
  if (!slot) throw new AppError('NOT_FOUND', 404, 'Slot not found');

  // Notify booked students before deleting
  if (slot.reservedCount > 0) {
    try {
      const userIds = await repo.getSlotBookedUserIds(id);
      const batchTitle = (slot as any).batch?.title ?? 'your class';
      const dateStr = slot.slotTime.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      await Promise.all(
        userIds.map((userId) =>
          sendPushNotifications({
            subjectId: userId,
            subjectRole: 'student',
            title: 'Class cancelled',
            body: `${batchTitle} on ${dateStr} has been cancelled.`,
            data: { screen: 'trials' },
          }).catch(() => {}),
        ),
      );
    } catch { /* push failure is non-fatal */ }
  }

  await repo.deleteSlot(id);
  return {};
}

export async function rescheduleSlot(id: string, academyId: string, newTime: string) {
  const slot = await repo.findSlot(id, academyId);
  if (!slot) throw new AppError('NOT_FOUND', 404, 'Slot not found');

  const slotTime = new Date(newTime);
  if (isNaN(slotTime.getTime())) throw new AppError('VALIDATION', 400, 'Invalid slot time');

  await repo.updateSlotTime(id, slotTime);

  // Notify booked students
  if (slot.reservedCount > 0) {
    try {
      const userIds = await repo.getSlotBookedUserIds(id);
      const batchTitle = (slot as any).batch?.title ?? 'your class';
      const newDateStr = slotTime.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      await Promise.all(
        userIds.map((userId) =>
          sendPushNotifications({
            subjectId: userId,
            subjectRole: 'student',
            title: 'Class rescheduled',
            body: `${batchTitle} has moved to ${newDateStr}.`,
            data: { screen: 'trials' },
          }).catch(() => {}),
        ),
      );
    } catch { /* push failure is non-fatal */ }
  }

  return {};
}
