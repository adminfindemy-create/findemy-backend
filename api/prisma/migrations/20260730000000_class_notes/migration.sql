-- Class notes: the academy's per-session record of what a batch covered, plus its attachments.
-- See ai-usage/class-notes_plan.md.
--
-- Purely additive (new tables + one nullable column), so a seeded database survives as-is.

-- ---------- class_notes ----------
CREATE TABLE "class_notes" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sessionDate" DATE NOT NULL,
    "body" TEXT,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_notes_pkey" PRIMARY KEY ("id")
);

-- One note per day's class (also the upsert key).
CREATE UNIQUE INDEX "class_notes_batchId_sessionDate_key" ON "class_notes"("batchId", "sessionDate");
CREATE INDEX "class_notes_batchId_sessionDate_idx" ON "class_notes"("batchId", "sessionDate");

ALTER TABLE "class_notes"
  ADD CONSTRAINT "class_notes_batchId_fkey" FOREIGN KEY ("batchId")
  REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- class_note_files ----------
CREATE TABLE "class_note_files" (
    "id" TEXT NOT NULL,
    "classNoteId" TEXT NOT NULL,
    -- Private storage key, NOT a public URL: notes are entitlement-gated and streamed
    -- through GET /me/notes/:fileId/file.
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_note_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "class_note_files_classNoteId_idx" ON "class_note_files"("classNoteId");

ALTER TABLE "class_note_files"
  ADD CONSTRAINT "class_note_files_classNoteId_fkey" FOREIGN KEY ("classNoteId")
  REFERENCES "class_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- enrollments.notesSeenAt ----------
-- NULL = never opened the notes screen, so every note counts as unread.
ALTER TABLE "enrollments" ADD COLUMN "notesSeenAt" TIMESTAMP(3);
