-- Family accounts, phase 1: learners and guardianships.
--
-- `users` stays the account (login, payments, push). `learners` is whoever attends. Every user
-- gets a self learner (users.selfLearnerId) carrying their existing attendance code, and every
-- existing enrollment, booking, trial and attendance row is pointed at it. learnerId stays
-- nullable here; it becomes required, with the unique keys moving onto it, in phase 2 once every
-- writer sets it.
-- See ai-usage/final-app/plan/family-accounts.md.

-- CreateEnum
CREATE TYPE "LearnerGender" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "LearnerStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "GuardianRole" AS ENUM ('self', 'owner');

-- CreateEnum
CREATE TYPE "AttendanceMethod" AS ENUM ('otp', 'manual', 'correction', 'auto');

-- AlterTable
ALTER TABLE "batch_attendances" ADD COLUMN     "learnerId" TEXT,
ADD COLUMN     "method" "AttendanceMethod" NOT NULL DEFAULT 'otp',
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "learnerId" TEXT;

-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "learnerId" TEXT;

-- AlterTable
ALTER TABLE "trials" ADD COLUMN     "learnerId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "selfLearnerId" TEXT;

-- CreateTable
CREATE TABLE "learners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dob" DATE,
    "gender" "LearnerGender",
    "avatarInitial" VARCHAR(2) NOT NULL,
    "attendanceOtp" VARCHAR(4) NOT NULL,
    "status" "LearnerStatus" NOT NULL DEFAULT 'active',
    "consentAt" TIMESTAMP(3),
    "consentVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardianships" (
    "userId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "role" "GuardianRole" NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardianships_pkey" PRIMARY KEY ("userId","learnerId")
);

-- CreateIndex
CREATE INDEX "guardianships_learnerId_idx" ON "guardianships"("learnerId");

-- CreateIndex
CREATE INDEX "batch_attendances_learnerId_idx" ON "batch_attendances"("learnerId");

-- CreateIndex
CREATE INDEX "bookings_learnerId_idx" ON "bookings"("learnerId");

-- CreateIndex
CREATE INDEX "enrollments_learnerId_idx" ON "enrollments"("learnerId");

-- CreateIndex
CREATE INDEX "trials_learnerId_idx" ON "trials"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "users_selfLearnerId_key" ON "users"("selfLearnerId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_selfLearnerId_fkey" FOREIGN KEY ("selfLearnerId") REFERENCES "learners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_attendances" ADD CONSTRAINT "batch_attendances_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------- Backfill ----------

-- One self learner per user, with the user's current name, initial and attendance code, so the
-- code shown in the app does not change. One statement so learner, guardianship and pointer are
-- written together.
WITH m AS (
  SELECT u.id AS uid,
         'lrn' || replace(gen_random_uuid()::text, '-', '') AS lid,
         COALESCE(u.name, '') AS name,
         u."avatarInitial",
         u."attendanceOtp",
         u."createdAt"
  FROM "users" u
  WHERE u."selfLearnerId" IS NULL
), ins AS (
  INSERT INTO "learners" ("id", "name", "avatarInitial", "attendanceOtp", "createdAt")
  SELECT lid, name, "avatarInitial", "attendanceOtp", "createdAt" FROM m
), g AS (
  INSERT INTO "guardianships" ("userId", "learnerId", "role", "createdAt")
  SELECT uid, lid, 'self', "createdAt" FROM m
)
UPDATE "users" u SET "selfLearnerId" = m.lid FROM m WHERE u.id = m.uid;

UPDATE "enrollments" t SET "learnerId" = u."selfLearnerId"
  FROM "users" u WHERE t."userId" = u.id AND t."learnerId" IS NULL;
UPDATE "bookings" t SET "learnerId" = u."selfLearnerId"
  FROM "users" u WHERE t."userId" = u.id AND t."learnerId" IS NULL;
UPDATE "trials" t SET "learnerId" = u."selfLearnerId"
  FROM "users" u WHERE t."userId" = u.id AND t."learnerId" IS NULL;
UPDATE "batch_attendances" t SET "learnerId" = u."selfLearnerId"
  FROM "users" u WHERE t."userId" = u.id AND t."learnerId" IS NULL;

-- How existing rows were written, read off the columns that already record it:
-- 'system' marker = session closer; any other account = staff correction; no account = the
-- student's code in studio, or auto-join for an online batch.
UPDATE "batch_attendances" a SET "method" = CASE
    WHEN a."markedByAccountId" = 'system' THEN 'auto'::"AttendanceMethod"
    WHEN a."markedByAccountId" IS NOT NULL THEN 'correction'::"AttendanceMethod"
    WHEN b."mode" = 'online' THEN 'auto'::"AttendanceMethod"
    ELSE 'otp'::"AttendanceMethod"
  END
  FROM "batches" b WHERE b.id = a."batchId";
