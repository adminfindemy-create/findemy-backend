import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repo so the service runs without a DB.
const getBatch = vi.fn();
const createSlots = vi.fn();
const findExistingSlotMillis = vi.fn();
vi.mock('./repo.js', () => ({
  getBatch: (...a: any[]) => getBatch(...a),
  createSlots: (...a: any[]) => createSlots(...a),
  findExistingSlotMillis: (...a: any[]) => findExistingSlotMillis(...a),
}));
// Push notifications are irrelevant here.
vi.mock('../push/service.js', () => ({ sendPushNotifications: vi.fn() }));

import { publishSlots } from './service.js';

beforeEach(() => {
  vi.clearAllMocks();
  createSlots.mockResolvedValue({});
  findExistingSlotMillis.mockResolvedValue(new Set<number>());
});

describe('publishSlots — IST wall-clock construction', () => {
  it('grid mode composes UTC from IST wall-clock (18:00 IST → 12:30 UTC)', async () => {
    getBatch.mockResolvedValue({ id: 'b1', capacity: 6, timings: [] });
    await publishSlots('aca1', {
      batch_id: 'b1',
      slots: [{ date: '2026-06-10', time: '18:00', capacity: 4 }],
    });
    const created = createSlots.mock.calls[0][0];
    expect(created).toHaveLength(1);
    expect(created[0].slotTime.toISOString()).toBe('2026-06-10T12:30:00.000Z');
    expect(created[0].capacity).toBe(4);
  });

  it('quick mode composes each timing as an IST wall-clock', async () => {
    getBatch.mockResolvedValue({
      id: 'b1',
      capacity: 6,
      timings: [{ startTime: '09:30', dayOfWeek: 3, durationMin: 60 }],
    });
    await publishSlots('aca1', { batch_id: 'b1', dates: ['2026-01-01'] });
    const created = createSlots.mock.calls[0][0];
    expect(created[0].slotTime.toISOString()).toBe('2026-01-01T04:00:00.000Z');
  });
});

describe('publishSlots — dedupe by (batch, slotTime)', () => {
  it('drops duplicate candidates within the same request', async () => {
    getBatch.mockResolvedValue({ id: 'b1', capacity: 6, timings: [] });
    await publishSlots('aca1', {
      batch_id: 'b1',
      slots: [
        { date: '2026-06-10', time: '18:00' },
        { date: '2026-06-10', time: '18:00' }, // exact dup
      ],
    });
    expect(createSlots.mock.calls[0][0]).toHaveLength(1);
  });

  it('drops candidates that already exist in the batch', async () => {
    getBatch.mockResolvedValue({ id: 'b1', capacity: 6, timings: [] });
    const existing = new Date('2026-06-10T12:30:00.000Z').getTime();
    findExistingSlotMillis.mockResolvedValue(new Set([existing]));
    const res = await publishSlots('aca1', {
      batch_id: 'b1',
      slots: [{ date: '2026-06-10', time: '18:00' }],
    });
    expect(createSlots).not.toHaveBeenCalled();
    expect(res.slots_created).toBe(0);
  });
});
