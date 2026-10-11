-- Family accounts, phase 2: attendance identity moves from the account to the learner.
--
-- learnerId becomes required on enrollments, bookings, trials and batch_attendances, and the
-- unique keys move onto it: one enrollment per learner per batch (so siblings can share a batch),
-- one attendance row per learner per session. userId stays on every row as the account that
-- booked and paid. See ai-usage/final-app/plan/family-accounts.md.

-- Safety net, same as phase 1's backfill: any user or row written without a learner between the
-- two deploys gets one now, so SET NOT NULL cannot fail.
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

-- DropForeignKey
ALTER TABLE "batch_attendances" DROP CONSTRAINT "batch_attendances_learnerId_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_learnerId_fkey";

-- DropForeignKey
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_learnerId_fkey";

-- DropForeignKey
ALTER TABLE "trials" DROP CONSTRAINT "trials_learnerId_fkey";

-- DropIndex
DROP INDEX "batch_attendances_batchId_userId_date_key";

-- DropIndex
DROP INDEX "batch_attendances_learnerId_idx";

-- DropIndex
DROP INDEX "enrollments_learnerId_idx";

-- DropIndex
DROP INDEX "enrollments_userId_batchId_key";

-- AlterTable
ALTER TABLE "batch_attendances" ALTER COLUMN "learnerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "bookings" ALTER COLUMN "learnerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "enrollments" ALTER COLUMN "learnerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "trials" ALTER COLUMN "learnerId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "batch_attendances_userId_idx" ON "batch_attendances"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_attendances_batchId_learnerId_date_key" ON "batch_attendances"("batchId", "learnerId", "date");

-- CreateIndex
CREATE INDEX "enrollments_userId_idx" ON "enrollments"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_learnerId_batchId_key" ON "enrollments"("learnerId", "batchId");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_attendances" ADD CONSTRAINT "batch_attendances_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

