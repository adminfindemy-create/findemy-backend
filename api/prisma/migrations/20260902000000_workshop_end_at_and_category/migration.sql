-- Workshops: a real end time, and an art form.
--
-- Two defects, one migration, because both are "the workshop cannot answer a question every
-- other discovery surface asks of it".
--
-- 1. PAST WORKSHOPS KEPT SHOWING. `workshops.status` is a stored string that nothing ever moves
--    off 'upcoming' — there is no job and no write path that retires one — so discovery, which
--    filtered on `status = 'upcoming'`, served workshops whose date had gone by. The student app
--    then filed them under "Today" (`bucketOf` buckets any past date as today). Time is now
--    answered by `endAt` and `status` keeps the meaning it actually has: draft vs published.
--
--    endAt, not startAt: a live session must stay listed while it runs — the same window the API
--    reports as `live`. Storing it rather than computing `startAt + durationMin * interval` per
--    query keeps the predicate an index seek and keeps it composable with LIMIT.
--
-- 2. NO CATEGORY. Every discovery surface filters by art form; `Workshop` had no such column, so
--    the student app's `workshopToItem` read an undefined `category` and every workshop fell out
--    of every filter except "All art forms". The academy's create form had no way to supply one.
--
-- ⚠️ Like 20260828000000_people_unification, this is applied in dev via `db push` (the chain
-- cannot replay — no migration ever creates `programs` or `academy_groups`). It is written to be
-- runnable and idempotent so it can serve the baseline that pre-production-checklist.md §2 owes.

-- ---------- endAt ----------
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "endAt" TIMESTAMP(3);

-- Backfill from what the row already knows. Exact, not an estimate: this is the same expression
-- the application now evaluates on every write.
UPDATE "workshops"
   SET "endAt" = "startAt" + ("durationMin" * INTERVAL '1 minute')
 WHERE "endAt" IS NULL;

ALTER TABLE "workshops" ALTER COLUMN "endAt" SET NOT NULL;

-- ---------- category ----------
-- Added nullable, backfilled, then made NOT NULL, so the migration is safe on a live table.
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "category" "Category";

-- A workshop's art form defaults to that of the branch running it. This is the honest inference
-- rather than a blanket default: a yoga studio's workshop is a yoga workshop, and the academy can
-- change it on the workshop itself if a branch ever runs something outside its own discipline.
UPDATE "workshops" w
   SET "category" = a."category"
  FROM "academies" a
 WHERE a."id" = w."academyId"
   AND w."category" IS NULL;

ALTER TABLE "workshops" ALTER COLUMN "category" SET NOT NULL;

-- ---------- the index discovery actually uses ----------
-- Published workshops that have not ended yet, in date order.
CREATE INDEX IF NOT EXISTS "workshops_status_endAt_idx" ON "workshops"("status", "endAt");
