import { describe, it, expect } from 'vitest';
import { serializeAttendance } from '../modules/attendance/service.js';

// Shaped like repo.getBatchAttendance's include: { user: { select: { id, name, phone } } }.
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    batchId: 'batch-1',
    userId: 'user-1',
    date: new Date('2026-06-07T00:00:00.000Z'),
    present: true,
    markedByAccountId: 'acct-1',
    markedAt: new Date('2026-06-07T10:00:00.000Z'),
    user: { id: 'user-1', name: 'Asha Rao', phone: '9876543210' },
    ...overrides,
  } as unknown as Parameters<typeof serializeAttendance>[0][number];
}

describe('serializeAttendance', () => {
  it('emits user_id (NOT id) so the client can key/toggle and POST marks (A1)', () => {
    const out = serializeAttendance([makeRecord()]);
    expect(out.students[0].user_id).toBe('user-1');
    // The legacy `id` key the client was never reading must be gone.
    expect((out.students[0] as Record<string, unknown>).id).toBeUndefined();
  });

  it('carries name and present through unchanged', () => {
    const out = serializeAttendance([
      makeRecord({ present: false, user: { id: 'u2', name: 'Dev Kumar', phone: '1' } }),
    ]);
    expect(out.students[0].name).toBe('Dev Kumar');
    expect(out.students[0].present).toBe(false);
  });

  it('returns an empty students array for no records', () => {
    const out = serializeAttendance([]);
    expect(out.students).toEqual([]);
  });
});
