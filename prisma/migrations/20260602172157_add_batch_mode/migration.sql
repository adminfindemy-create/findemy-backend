-- CreateEnum
CREATE TYPE "BatchMode" AS ENUM ('online', 'offline');

-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "mode" "BatchMode" NOT NULL DEFAULT 'offline';
