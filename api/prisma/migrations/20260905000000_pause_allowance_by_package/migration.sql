-- Pause allowance by package (owner decision 2026-09-05):
--   monthly  → 1 week per paid period
--   quarterly → 2 weeks per paid period, splittable into two 1-week pauses
-- The allowance is per PERIOD and refreshes on renewal, so a pause must record which period it
-- is charged against. `one_month` becomes unreachable and is removed from the enum.

-- 1. Charge each pause to a paid period.
ALTER TABLE "enrollment_pauses" ADD COLUMN "enrollmentPeriodId" TEXT;

ALTER TABLE "enrollment_pauses"
  ADD CONSTRAINT "enrollment_pauses_enrollmentPeriodId_fkey"
  FOREIGN KEY ("enrollmentPeriodId") REFERENCES "enrollment_periods"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "enrollment_pauses_enrollmentPeriodId_status_idx"
  ON "enrollment_pauses"("enrollmentPeriodId", "status");

-- 2. Best-effort backfill: attribute each existing pause to the period whose date range contains
--    its start (falling back to the enrolment's latest period for pauses never started). Rows that
--    match nothing stay NULL and are excluded from every allowance sum, so a legacy pause can
--    never make a student's remaining allowance go negative.
UPDATE "enrollment_pauses" p
SET "enrollmentPeriodId" = (
  SELECT e."id" FROM "enrollment_periods" e
  WHERE e."enrollmentId" = p."enrollmentId"
    AND (
      p."startDate" IS NULL
      OR (p."startDate"::date >= e."startDate" AND p."startDate"::date <= e."endDate")
    )
  ORDER BY
    -- prefer a genuine date-range match over the fallback
    CASE WHEN p."startDate" IS NULL THEN 1 ELSE 0 END,
    e."endDate" DESC
  LIMIT 1
)
WHERE p."enrollmentPeriodId" IS NULL;

-- 3. Retire `one_month`. Any surviving row is folded down to the new 2-week ceiling first —
--    Postgres will not retype the column while a value outside the new enum exists.
UPDATE "enrollment_pauses" SET "duration" = 'two_weeks' WHERE "duration" = 'one_month';

ALTER TYPE "PauseDuration" RENAME TO "PauseDuration_old";
CREATE TYPE "PauseDuration" AS ENUM ('one_week', 'two_weeks');
ALTER TABLE "enrollment_pauses"
  ALTER COLUMN "duration" TYPE "PauseDuration"
  USING ("duration"::text::"PauseDuration");
DROP TYPE "PauseDuration_old";
