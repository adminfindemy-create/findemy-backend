import { prisma } from '../../lib/prisma.js';
import { batchScopeById, type BatchScope } from '../../lib/scope.js';
import { LEARNER_PUSH_SELECT } from '../../lib/learner-access.js';

// Class notes. Anchored to the virtual session key (batchId, sessionDate) — same pattern as
// BatchAttendance / ClassSession / SessionReminderSent. See ai-usage/class-notes_plan.md.

export async function findBatchForAcademy(batchId: string, scope: BatchScope) {
  return prisma.batch.findFirst({
    where: batchScopeById(scope, batchId),
    include: { timings: true },
  });
}

export async function findNote(batchId: string, sessionDate: Date) {
  return prisma.classNote.findUnique({
    where: { batchId_sessionDate: { batchId, sessionDate } },
    include: { files: { orderBy: { createdAt: 'asc' } } },
  });
}

/**
 * Upsert the note for a session. `created` tells the caller whether this call brought the row
 * into existence — that is the trigger for the single per-session push (attaching three files
 * to Tuesday's class must not send three notifications).
 */
export async function upsertNote(args: {
  batchId: string;
  sessionDate: Date;
  body?: string | null;
  createdByAccountId: string;
}) {
  const existing = await prisma.classNote.findUnique({
    where: { batchId_sessionDate: { batchId: args.batchId, sessionDate: args.sessionDate } },
  });
  if (existing) {
    const note =
      args.body === undefined
        ? existing
        : await prisma.classNote.update({ where: { id: existing.id }, data: { body: args.body } });
    return { note, created: false };
  }
  const note = await prisma.classNote.create({
    data: {
      batchId: args.batchId,
      sessionDate: args.sessionDate,
      body: args.body ?? null,
      createdByAccountId: args.createdByAccountId,
    },
  });
  return { note, created: true };
}

export async function addFile(args: {
  classNoteId: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}) {
  return prisma.classNoteFile.create({ data: args });
}

/**
 * Bump `updatedAt` without changing content. Called when files are attached or removed so the
 * student's unread comparison (updatedAt vs Enrollment.notesSeenAt) catches a PDF added hours
 * after the note itself was written.
 */
export async function touchNote(id: string) {
  await prisma.classNote.update({ where: { id }, data: { updatedAt: new Date() } });
}

export async function countFiles(classNoteId: string) {
  return prisma.classNoteFile.count({ where: { classNoteId } });
}

/** Loads the file with enough graph to authorise both the academy and the student paths. */
export async function findFileById(fileId: string) {
  return prisma.classNoteFile.findUnique({
    where: { id: fileId },
    // `coachId` is selected so the service can apply the caller's batch scope — a file is
    // reached by id alone, so this is the only thing that gates it.
    include: { classNote: { include: { batch: { select: { id: true, academyId: true, coachId: true, title: true } } } } },
  });
}

export async function deleteFile(fileId: string) {
  await prisma.classNoteFile.delete({ where: { id: fileId } });
}

/** Hard delete — the row and (via cascade) its file rows. Stored objects are removed separately. */
export async function deleteNote(id: string) {
  await prisma.classNote.delete({ where: { id } });
}

/** Notes for a batch, newest session first. `from`/`to` bound a non-active student's window. */
export async function listNotesForBatch(batchId: string, from?: Date, to?: Date) {
  return prisma.classNote.findMany({
    where: {
      batchId,
      ...(from || to ? { sessionDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    include: { files: { orderBy: { createdAt: 'asc' } } },
    orderBy: { sessionDate: 'desc' },
  });
}

/**
 * The student's enrolment plus the last period's endDate — the two facts the eligibility window
 * needs. Ordered endDate desc so periods[0] is the furthest-reaching period.
 */
export async function findEnrollmentForUser(enrollmentId: string, userId: string) {
  return prisma.enrollment.findFirst({
    where: { id: enrollmentId, userId },
    include: {
      // The academy is the sender in the student's notes thread — name + first image
      // are what the avatar and byline need.
      batch: {
        select: { id: true, title: true, academy: { select: { name: true, images: true } } },
      },
      periods: { select: { endDate: true }, orderBy: { endDate: 'desc' }, take: 1 },
    },
  });
}

/**
 * The enrolments this account holds on a batch — used to gate the file stream. More than one
 * when siblings share a batch; any of them entitles the guardian to the note.
 */
export async function findEnrollmentsForUserAndBatch(userId: string, batchId: string) {
  return prisma.enrollment.findMany({
    where: { userId, batchId },
    include: { periods: { select: { endDate: true }, orderBy: { endDate: 'desc' }, take: 1 } },
  });
}

export async function stampNotesSeen(enrollmentId: string, at: Date) {
  await prisma.enrollment.update({ where: { id: enrollmentId }, data: { notesSeenAt: at } });
}

/**
 * Active enrollees of a batch — the push audience for a newly created note. The enrolment id
 * travels with each notification so the deep link can open that student's notes screen, which
 * is keyed by enrolment rather than batch.
 */
export async function findActiveEnrollees(batchId: string) {
  return prisma.enrollment.findMany({
    where: { batchId, status: 'active' },
    select: { id: true, userId: true, learner: LEARNER_PUSH_SELECT },
  });
}
