-- DropForeignKey
ALTER TABLE "academy_accounts" DROP CONSTRAINT "academy_accounts_academyId_fkey";

-- AddForeignKey
ALTER TABLE "academy_accounts" ADD CONSTRAINT "academy_accounts_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
