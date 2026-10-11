import { AppError } from '../../lib/app-error.js';
import { istDateKey, sessionDateIST } from '../../lib/ist.js';
import {
  storePrivateFile,
  readPrivateFile,
  deletePrivateFile,
  NOTE_MAX_BYTES,
} from '../../lib/media-storage.js';
import { sendPushNotifications } from '../push/service.js';
import * as repo from './repo.js';
import type { BatchScope } from '../../lib/scope.js';
import { whose } from '../../lib/learner-access.js';

// Class notes — the academy's record of what a batch covered on a given day, read by its
// enrolled students. See ai-usage/class-notes_plan.md for the decisions behind this.

// Notes must stay small enough for a teacher to attach over mobile data.
export const MAX_FILES_PER_SESSION = 5;

type NoteWithFiles = {
  id: string;
  sessionDate: Date;
  body: string | null;
  createdAt: Date;
  updatedAt: Date;
  files: {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }[];
};

function serializeNote(note: NoteWithFiles) {
  return {
    id: note.id,
    session_date: istDateKey(note.sessionDate),
    body: note.body,
    created_at: note.createdAt.toISOString(),
    updated_at: note.updatedAt.toISOString(),
    files: note.files.map((f) => ({
      id: f.id,
      file_name: f.fileName,
      mime_type: f.mimeType,
      size_bytes: f.sizeBytes,
      // The client renders images inline and downloads everything else.
      kind: f.mimeType.startsWith('image/') ? ('image' as const) : ('file' as const),
    })),
  };
}

/** Parse a 'yyyy-MM-dd' session date into the @db.Date value used as the anchor key. */
function parseSessionDate(dateStr: string | undefined): Date {
  if (!dateStr) throw new AppError('VALIDATION', 400, 'A session date is required');
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new AppError('VALIDATION', 400, 'Invalid session date');
  return date;
}

/**
 * Load the batch (scoped to the calling academy) and validate the session date against it:
 * the batch must actually meet on that weekday, and the class must already have happened.
 */
async function requireSession(scope: BatchScope, batchId: string, dateStr: string | undefined) {
  const batch = await repo.findBatchForAcademy(batchId, scope);
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');

  const sessionDate = parseSessionDate(dateStr);
  // Without this, notes could be filed against a date the batch never met.
  if (!batch.timings.some((t) => t.dayOfWeek === sessionDate.getUTCDay())) {
    throw new AppError('VALIDATION', 400, 'This batch has no class on that day');
  }
  // Notes are a write-up of a class that happened, so today is the latest allowed date.
  if (sessionDate > sessionDateIST()) {
    throw new AppError('VALIDATION', 400, "You can't add notes for a class that hasn't happened yet");
  }
  return { batch, sessionDate };
}

// ─── Academy ─────────────────────────────────────────────────────────────────

export async function getNoteForSession(scope: BatchScope, batchId: string, dateStr?: string) {
  const { sessionDate } = await requireSession(scope, batchId, dateStr);
  const note = await repo.findNote(batchId, sessionDate);
  return { note: note ? serializeNote(note) : null };
}

/**
 * Upsert the note for a session. Two shapes share this route:
 *   * JSON `{ body }`        → set / clear the "what we covered" text.
 *   * multipart with a file  → append one attachment (optional `body` field alongside).
 * A note must end up with a body or at least one file, so an empty text-only save is rejected.
 */
export async function saveNote(args: {
  scope: BatchScope;
  accountId: string;
  batchId: string;
  dateStr?: string;
  body?: string | null;
  file?: { buffer: Buffer; mimeType: string; fileName: string };
}) {
  const { batch, sessionDate } = await requireSession(args.scope, args.batchId, args.dateStr);

  const existing = await repo.findNote(args.batchId, sessionDate);
  const bodyAfter = args.body !== undefined ? (args.body?.trim() || null) : (existing?.body ?? null);
  const filesAfter = (existing?.files.length ?? 0) + (args.file ? 1 : 0);
  if (!bodyAfter && filesAfter === 0) {
    throw new AppError('VALIDATION', 400, 'Add a note or attach a file');
  }
  if (args.file && (existing?.files.length ?? 0) >= MAX_FILES_PER_SESSION) {
    throw new AppError(
      'VALIDATION',
      400,
      `A class can carry ${MAX_FILES_PER_SESSION} files. Remove one before adding another.`,
    );
  }

  // Store the object BEFORE the row so a failed upload never leaves a note pointing at nothing.
  let stored: { storageKey: string; sizeBytes: number } | null = null;
  if (args.file) {
    stored = await storePrivateFile({
      keyPrefix: `class-notes/${args.batchId}`,
      buffer: args.file.buffer,
      mimeType: args.file.mimeType,
      maxBytes: NOTE_MAX_BYTES,
    });
  }

  const { note, created } = await repo.upsertNote({
    batchId: args.batchId,
    sessionDate,
    body: args.body !== undefined ? bodyAfter : undefined,
    createdByAccountId: args.accountId,
  });

  if (stored && args.file) {
    await repo.addFile({
      classNoteId: note.id,
      storageKey: stored.storageKey,
      fileName: args.file.fileName,
      mimeType: args.file.mimeType,
      sizeBytes: stored.sizeBytes,
    });
    if (!created) await repo.touchNote(note.id);
  }

  // One push per session date — fired only when the row is first created, so attaching three
  // files to Tuesday's class notifies once.
  if (created) {
    await notifyNoteAdded(args.batchId, batch.title, sessionDate).catch(() => {});
  }

  const fresh = await repo.findNote(args.batchId, sessionDate);
  return { note: fresh ? serializeNote(fresh) : null, created };
}

export async function deleteNoteFile(scope: BatchScope, fileId: string) {
  const file = await repo.findFileById(fileId);
  // Reached by file id alone, so the batch check is the ONLY gate. It now compares against the
  // full scope rather than the branch: a teacher must not be able to delete an attachment from
  // another coach's class note by guessing a file id.
  const b = file?.classNote.batch;
  const outOfScope =
    !b ||
    b.academyId !== scope.academyId ||
    (scope.coachId !== undefined && !scope.coachId.in.includes(b.coachId));
  if (outOfScope) {
    throw new AppError('NOT_FOUND', 404, 'File not found');
  }
  await repo.deleteFile(fileId);
  await repo.touchNote(file.classNoteId);
  await deletePrivateFile(file.storageKey);
  return { deleted: true };
}

/** Hard delete: the note row, its file rows (cascade) and the stored objects. */
export async function deleteNoteForSession(scope: BatchScope, batchId: string, dateStr?: string) {
  const { sessionDate } = await requireSession(scope, batchId, dateStr);
  const note = await repo.findNote(batchId, sessionDate);
  if (!note) throw new AppError('NOT_FOUND', 404, 'No notes for that class');
  await repo.deleteNote(note.id);
  await Promise.all(note.files.map((f) => deletePrivateFile(f.storageKey)));
  return { deleted: true };
}

// ─── Student ─────────────────────────────────────────────────────────────────

/**
 * What this student is entitled to read.
 *   * active enrolment → every note for the batch, regardless of attendance. The student who
 *     most needs notes is the one who was ill.
 *   * otherwise        → only notes inside the window they paid for: startedAt → last period's
 *     endDate. Known caveat: the window spans pauses (accepted; see the plan).
 */
function eligibilityWindow(enrollment: {
  status: string;
  startedAt: Date;
  periods: { endDate: Date }[];
}): { from?: Date; to?: Date; none?: true } {
  if (enrollment.status === 'active') return {};
  const lastEnd = enrollment.periods[0]?.endDate;
  if (!lastEnd) return { none: true };
  return { from: new Date(`${istDateKey(enrollment.startedAt)}T00:00:00.000Z`), to: lastEnd };
}

export async function listNotesForStudent(userId: string, enrollmentId: string) {
  const enrollment = await repo.findEnrollmentForUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');

  const window = eligibilityWindow(enrollment);
  const notes = window.none
    ? []
    : await repo.listNotesForBatch(enrollment.batchId, window.from, window.to);

  const seenAt = enrollment.notesSeenAt;
  const items = notes.map((n) => ({
    ...serializeNote(n),
    is_new: !seenAt || n.updatedAt > seenAt,
  }));

  return {
    batch_title: enrollment.batch.title,
    // The notes read as a thread from the academy, so the client needs its identity.
    academy_name: enrollment.batch.academy.name,
    academy_image: enrollment.batch.academy.images[0] ?? null,
    unread_count: items.filter((i) => i.is_new).length,
    items,
  };
}

export async function markNotesSeen(userId: string, enrollmentId: string) {
  const enrollment = await repo.findEnrollmentForUser(enrollmentId, userId);
  if (!enrollment) throw new AppError('NOT_FOUND', 404, 'Enrollment not found');
  const at = new Date();
  await repo.stampNotesSeen(enrollment.id, at);
  return { notes_seen_at: at.toISOString() };
}

/**
 * Gated byte stream. The eligibility check is re-run here rather than trusted from the list
 * call — this is the only thing standing between a note and an unentitled fetch, because the
 * objects are never publicly served.
 *
 * Download is permitted, so nothing is truly revocable: once a student has the PDF they can
 * reshare the file itself. The gate stops unentitled *fetches*, not onward sharing.
 */
export async function readNoteFileForStudent(userId: string, fileId: string) {
  const file = await repo.findFileById(fileId);
  if (!file) throw new AppError('NOT_FOUND', 404, 'File not found');

  const enrollments = await repo.findEnrollmentsForUserAndBatch(userId, file.classNote.batchId);
  // Trials aren't enrolments: notes are a paid-enrolment benefit.
  if (enrollments.length === 0) throw new AppError('FORBIDDEN', 403, 'You are not enrolled in this class');

  const sessionDate = file.classNote.sessionDate;
  const allowed = enrollments.some((enrollment) => {
    const window = eligibilityWindow(enrollment);
    return (
      !window.none &&
      (!window.from || sessionDate >= window.from) &&
      (!window.to || sessionDate <= window.to)
    );
  });
  if (!allowed) {
    throw new AppError('FORBIDDEN', 403, 'This note is outside the period you were enrolled for');
  }

  const object = await readPrivateFile(file.storageKey);
  if (!object) throw new AppError('NOT_FOUND', 404, 'File not found');
  return { ...object, fileName: file.fileName };
}

// ─── Push ────────────────────────────────────────────────────────────────────

async function notifyNoteAdded(batchId: string, batchTitle: string, sessionDate: Date) {
  const enrollees = await repo.findActiveEnrollees(batchId);
  if (enrollees.length === 0) return;
  const label = sessionDate.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC', // sessionDate is a date-only value; don't let the host TZ shift it.
  });
  await Promise.all(
    enrollees.map((e) =>
      sendPushNotifications({
        subjectId: e.userId,
        subjectRole: 'student',
        title: 'Class notes added',
        body: `Notes added for ${whose(e.learner, { lower: true })} ${batchTitle} class · ${label}`,
        // The notes screen is keyed by enrolment, so each student gets their own id.
        data: { screen: 'class-notes', enrollment_id: e.id, session_date: istDateKey(sessionDate) },
      }).catch(() => {}),
    ),
  );
}
