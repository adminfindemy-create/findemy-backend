-- AlterTable: users -- relax NOT NULLs and add OAuth columns
ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "location" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "lat" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "lng" DROP NOT NULL;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "appleSub" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;

-- AlterTable: academy_accounts -- relax NOT NULLs, drop+recreate FK with NO ACTION (since academyId becomes nullable), add OAuth columns + ownerName
ALTER TABLE "academy_accounts" DROP CONSTRAINT IF EXISTS "academy_accounts_academyId_fkey";

ALTER TABLE "academy_accounts" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "academy_accounts" ALTER COLUMN "academyId" DROP NOT NULL;

ALTER TABLE "academy_accounts" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "academy_accounts" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "academy_accounts" ADD COLUMN IF NOT EXISTS "appleSub" TEXT;
ALTER TABLE "academy_accounts" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;
ALTER TABLE "academy_accounts" ADD COLUMN IF NOT EXISTS "ownerName" TEXT;

ALTER TABLE "academy_accounts" ADD CONSTRAINT "academy_accounts_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: academies -- relax NOT NULLs on lat/lng
ALTER TABLE "academies" ALTER COLUMN "lat" DROP NOT NULL;
ALTER TABLE "academies" ALTER COLUMN "lng" DROP NOT NULL;

-- CreateIndex: unique indexes for new OAuth columns
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_appleSub_key" ON "users"("appleSub");
CREATE UNIQUE INDEX IF NOT EXISTS "users_googleSub_key" ON "users"("googleSub");

CREATE UNIQUE INDEX IF NOT EXISTS "academy_accounts_email_key" ON "academy_accounts"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "academy_accounts_appleSub_key" ON "academy_accounts"("appleSub");
CREATE UNIQUE INDEX IF NOT EXISTS "academy_accounts_googleSub_key" ON "academy_accounts"("googleSub");
