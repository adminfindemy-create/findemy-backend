-- Syncs the dev database up to prisma/schema.prisma. The DB had drifted significantly behind
-- the schema (columns/tables referenced by app code but never migrated). Two spots needed
-- manual handling beyond a plain `prisma migrate diff` output:
--   1. batches.programId is a new NOT NULL FK column but `batches` already has rows, so we
--      backfill one Program per existing Batch (title/category/academyId) before adding the
--      NOT NULL constraint (expand -> backfill -> contract).
--   2. users.attendanceOtp is narrowed to VARCHAR(4) but had stale 6-char values from before
--      the OTP length shrank; truncated to 4 chars since these are ephemeral rotating codes.

-- CreateEnum
CREATE TYPE "OfferedMode" AS ENUM ('in_studio', 'online', 'home_visit');

-- CreateEnum
CREATE TYPE "CommissionItemType" AS ENUM ('trial', 'enrollment', 'workshop', 'event');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('accrued', 'reversed');

-- CreateEnum
CREATE TYPE "ReserveStatus" AS ENUM ('held', 'released', 'consumed');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('class', 'attendance');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('trial', 'enrollment');

-- AlterEnum
ALTER TYPE "BatchStatus" ADD VALUE 'closing';
ALTER TYPE "BatchStatus" ADD VALUE 'ended';

-- AlterEnum
BEGIN;
CREATE TYPE "WorkshopType_new" AS ENUM ('online', 'offline');
ALTER TABLE "workshops" ALTER COLUMN "type" TYPE "WorkshopType_new" USING ("type"::text::"WorkshopType_new");
ALTER TYPE "WorkshopType" RENAME TO "WorkshopType_old";
ALTER TYPE "WorkshopType_new" RENAME TO "WorkshopType";
DROP TYPE "WorkshopType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_slotId_fkey";

-- DropForeignKey
ALTER TABLE "expo_push_tokens" DROP CONSTRAINT "pt_user_fk";

-- DropForeignKey
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_trialId_fkey";

-- DropForeignKey
ALTER TABLE "trials" DROP CONSTRAINT "trials_slotId_fkey";

-- DropIndex
DROP INDEX "bookings_slotId_status_idx";

-- AlterTable
ALTER TABLE "academies" ADD COLUMN     "modesOffered" "OfferedMode"[] DEFAULT ARRAY[]::"OfferedMode"[],
ADD COLUMN     "reserveRateBps" INTEGER NOT NULL DEFAULT 1000;

-- AlterTable
ALTER TABLE "batch_attendances" ALTER COLUMN "markedByAccountId" DROP NOT NULL;

-- AlterTable (programId added nullable here; backfilled below, then made NOT NULL)
ALTER TABLE "batches" ADD COLUMN     "annualDiscountBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "discontinueRequestedAt" TIMESTAMP(3),
ADD COLUMN     "liveRoomId" TEXT,
ADD COLUMN     "programId" TEXT,
ADD COLUMN     "quarterlyDiscountBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sessionsPerMonth" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "thingsToKnow" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "trialAt" TIMESTAMP(3),
ALTER COLUMN "slotId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "coaches" ADD COLUMN     "avatarUrl" TEXT;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "divisions" TEXT[],
ADD COLUMN     "isSpotlight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prizePaise" INTEGER;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "enrollmentId" TEXT,
ADD COLUMN     "source" "ReviewSource" NOT NULL DEFAULT 'trial',
ALTER COLUMN "trialId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "trials" ALTER COLUMN "slotId" DROP NOT NULL;

-- Truncate stale OTPs (ephemeral codes) so they fit the narrowed column below
UPDATE "users" SET "attendanceOtp" = LEFT("attendanceOtp", 4) WHERE length("attendanceOtp") > 4;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "attendanceOtp" SET DATA TYPE VARCHAR(4);

-- CreateTable
CREATE TABLE "commission_ledger" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "itemType" "CommissionItemType" NOT NULL,
    "itemId" TEXT NOT NULL,
    "grossPaise" INTEGER NOT NULL,
    "commissionBps" INTEGER NOT NULL,
    "commissionPaise" INTEGER NOT NULL,
    "reversedPaise" INTEGER NOT NULL DEFAULT 0,
    "status" "CommissionStatus" NOT NULL DEFAULT 'accrued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_holds" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "consumedPaise" INTEGER NOT NULL DEFAULT 0,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releaseAt" TIMESTAMP(3) NOT NULL,
    "status" "ReserveStatus" NOT NULL DEFAULT 'held',

    CONSTRAINT "reserve_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_recoveries" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "grossPaise" INTEGER NOT NULL,
    "reserveAppliedPaise" INTEGER NOT NULL DEFAULT 0,
    "negativePaise" INTEGER NOT NULL DEFAULT 0,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "description" TEXT,
    "thingsToKnow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_media" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_reminders_sent" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sessionDate" DATE NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_reminders_sent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancelled_sessions" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sessionDate" DATE NOT NULL,
    "reason" TEXT,
    "cancelledByAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancelled_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_credits" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "cancelledSessionId" TEXT,
    "reason" TEXT NOT NULL,
    "sessionCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_credits_pkey" PRIMARY KEY ("id")
);

-- Backfill: one Program per existing Batch (denormalized title/category/academyId), then point
-- the batch at it. Matches the schema's expand->migrate->contract comment on Batch.
DO $$
DECLARE
  b RECORD;
  new_program_id TEXT;
BEGIN
  FOR b IN SELECT id, "academyId", title, category FROM "batches" WHERE "programId" IS NULL LOOP
    new_program_id := gen_random_uuid()::text;
    INSERT INTO "programs" ("id", "academyId", "title", "category", "createdAt")
    VALUES (new_program_id, b."academyId", b.title, b.category, now());
    UPDATE "batches" SET "programId" = new_program_id WHERE id = b.id;
  END LOOP;
END $$;

-- AlterTable
ALTER TABLE "batches" ALTER COLUMN "programId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "commission_ledger_academyId_status_idx" ON "commission_ledger"("academyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commission_ledger_itemType_itemId_key" ON "commission_ledger"("itemType", "itemId");

-- CreateIndex
CREATE INDEX "reserve_holds_academyId_status_idx" ON "reserve_holds"("academyId", "status");

-- CreateIndex
CREATE INDEX "academy_recoveries_academyId_idx" ON "academy_recoveries"("academyId");

-- CreateIndex
CREATE INDEX "programs_academyId_idx" ON "programs"("academyId");

-- CreateIndex
CREATE INDEX "program_media_programId_idx" ON "program_media"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "session_reminders_sent_batchId_sessionDate_kind_key" ON "session_reminders_sent"("batchId", "sessionDate", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "cancelled_sessions_batchId_sessionDate_key" ON "cancelled_sessions"("batchId", "sessionDate");

-- CreateIndex
CREATE INDEX "session_credits_enrollmentId_idx" ON "session_credits"("enrollmentId");

-- CreateIndex
CREATE INDEX "batches_programId_idx" ON "batches"("programId");

-- CreateIndex
CREATE INDEX "bookings_trialAt_status_idx" ON "bookings"("trialAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_enrollmentId_key" ON "reviews"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_userId_academyId_key" ON "reviews"("userId", "academyId");

-- AddForeignKey
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_holds" ADD CONSTRAINT "reserve_holds_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_recoveries" ADD CONSTRAINT "academy_recoveries_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_media" ADD CONSTRAINT "program_media_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_reminders_sent" ADD CONSTRAINT "session_reminders_sent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancelled_sessions" ADD CONSTRAINT "cancelled_sessions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_credits" ADD CONSTRAINT "session_credits_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_credits" ADD CONSTRAINT "session_credits_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_credits" ADD CONSTRAINT "session_credits_cancelledSessionId_fkey" FOREIGN KEY ("cancelledSessionId") REFERENCES "cancelled_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trialId_fkey" FOREIGN KEY ("trialId") REFERENCES "trials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
