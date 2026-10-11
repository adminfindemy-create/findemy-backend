-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'claimed', 'expired');

-- AlterTable
ALTER TABLE "academies" ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "trials" ADD COLUMN     "reminderSent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referralPoints" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "saved_academies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_academies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referreeId" TEXT,
    "code" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saved_academies_userId_academyId_key" ON "saved_academies"("userId", "academyId");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_code_key" ON "referrals"("code");

-- AddForeignKey
ALTER TABLE "saved_academies" ADD CONSTRAINT "saved_academies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_academies" ADD CONSTRAINT "saved_academies_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referreeId_fkey" FOREIGN KEY ("referreeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
