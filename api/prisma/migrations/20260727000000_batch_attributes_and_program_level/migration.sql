-- Batch attributes (age range / session format / gender) + `level` moves Batch -> Program.
-- See ai-usage/final-app/plan/batch-attributes-and-level-move.md
--
-- Written as add-backfill-constrain-drop so an existing (seeded) database survives
-- the move instead of requiring a reseed.

-- ---------- new enums ----------
CREATE TYPE "SessionFormat" AS ENUM ('group', 'one_on_one');
CREATE TYPE "BatchGender" AS ENUM ('anyone', 'female_only');

-- ---------- programs.level (moved up from batches) ----------
ALTER TABLE "programs" ADD COLUMN "level" TEXT;

-- Backfill each program from its oldest batch's level.
UPDATE "programs" p
SET "level" = b."level"
FROM (
  SELECT DISTINCT ON ("programId") "programId", "level"
  FROM "batches"
  ORDER BY "programId", "createdAt" ASC
) b
WHERE b."programId" = p."id";

-- Programs with no batches have nothing to inherit.
UPDATE "programs" SET "level" = 'Beginner' WHERE "level" IS NULL;

ALTER TABLE "programs" ALTER COLUMN "level" SET NOT NULL;

-- ---------- batches.name (replaces level as the sibling-distinguishing label) ----------
ALTER TABLE "batches" ADD COLUMN "name" TEXT;
UPDATE "batches" SET "name" = "level" WHERE "name" IS NULL;
ALTER TABLE "batches" ALTER COLUMN "name" SET NOT NULL;

-- ---------- batches: new attributes ----------
ALTER TABLE "batches" ADD COLUMN "minAge" INTEGER;
ALTER TABLE "batches" ADD COLUMN "maxAge" INTEGER;
ALTER TABLE "batches" ADD COLUMN "sessionFormat" "SessionFormat" NOT NULL DEFAULT 'group';
ALTER TABLE "batches" ADD COLUMN "gender" "BatchGender" NOT NULL DEFAULT 'anyone';

-- ---------- drop the moved column ----------
ALTER TABLE "batches" DROP COLUMN "level";
