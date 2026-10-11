-- Sessions become records, and CancelledSession folds into them.
-- See ai-usage/attendance-tracking_plan.md decisions 1 & 2.
--
-- Ordered add → backfill → repoint → drop so a seeded database survives: every cancelled_sessions
-- row becomes a class_sessions row with status 'cancelled', and its SessionCredits follow it.

-- ---------- class_sessions ----------
CREATE TYPE "ClassSessionStatus" AS ENUM ('held', 'cancelled');

CREATE TABLE "class_sessions" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sessionDate" DATE NOT NULL,
    "status" "ClassSessionStatus" NOT NULL DEFAULT 'held',
    -- NULL = not closed yet, or closed with zero check-ins ("not recorded").
    "finalisedAt" TIMESTAMP(3),
    "reason" TEXT,
    "cancelledByAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id")
);

-- One row per day's class — also the upsert key for both check-in and cancellation.
CREATE UNIQUE INDEX "class_sessions_batchId_sessionDate_key" ON "class_sessions"("batchId", "sessionDate");
CREATE INDEX "class_sessions_batchId_sessionDate_idx" ON "class_sessions"("batchId", "sessionDate");

ALTER TABLE "class_sessions"
  ADD CONSTRAINT "class_sessions_batchId_fkey" FOREIGN KEY ("batchId")
  REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- backfill from cancelled_sessions ----------
-- Cancellations are the one session fact that WAS stored, so they carry over verbatim (ids kept,
-- which is what lets session_credits be repointed by a plain id copy below).
INSERT INTO "class_sessions" ("id", "batchId", "sessionDate", "status", "finalisedAt", "reason", "cancelledByAccountId", "createdAt")
SELECT "id", "batchId", "sessionDate", 'cancelled', NULL, "reason", "cancelledByAccountId", "createdAt"
FROM "cancelled_sessions";

-- ---------- session_credits.cancelledSessionId → classSessionId ----------
ALTER TABLE "session_credits" ADD COLUMN "classSessionId" TEXT;

UPDATE "session_credits" SET "classSessionId" = "cancelledSessionId" WHERE "cancelledSessionId" IS NOT NULL;

ALTER TABLE "session_credits" DROP CONSTRAINT IF EXISTS "session_credits_cancelledSessionId_fkey";
ALTER TABLE "session_credits" DROP COLUMN "cancelledSessionId";

ALTER TABLE "session_credits"
  ADD CONSTRAINT "session_credits_classSessionId_fkey" FOREIGN KEY ("classSessionId")
  REFERENCES "class_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- drop cancelled_sessions ----------
DROP TABLE "cancelled_sessions";
