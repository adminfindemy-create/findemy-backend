-- One person, one record: a coach and a teacher are the same human.
-- See the People-unification plan and ai-usage/final-app/plan/academy-staff-roles.md.
--
-- `Coach` (the public teaching identity students see) and `StaffAccount` (the login) describe
-- one person. Nothing in the database said so: `coaches` has no uniqueness of any kind, and
-- `staff_role_assignments.coachId` had only a plain index — so two logins could claim one coach,
-- and a free-text invite name could mint a second Ravi whose batches stayed on the first.
--
-- The tables stay separate on purpose: a MANAGER has a login and no teaching profile, and
-- `batches.coachId` points here because a batch is taught by a person, not by a login. What
-- changes is that the 1:1 is now enforced, and that a teacher's Coach row is created by the
-- invite itself — so the invalid state is unreachable rather than merely rejected.
--
-- ⚠️ Applied in this environment via `db push` + reseed, not by `migrate deploy`: the migration
-- chain cannot replay (no migration ever creates `programs` or `academy_groups`). Kept for the
-- record and for the baseline that pre-production-checklist.md §2 still owes.

-- ---------- coaches: experience & qualifications, and the phone goes ----------
-- ONE field, because that is how a teacher writes it: "10 years teaching · Trinity Grade 8".
-- Two columns would only invite two half-filled boxes.
ALTER TABLE "coaches" ADD COLUMN "credentials" TEXT;

-- Every coach now has a login, so `staff_accounts.phone` is the single place a person's number
-- lives. This also closes a leak on the way out: `coaches.phone` was being returned to
-- logged-in students by the academy detail read, and stripped only for anonymous visitors.
ALTER TABLE "coaches" DROP COLUMN "phone";

-- ---------- the constraint whose absence let one person become two ----------
-- A coach may back at most ONE login. The column is nullable and Postgres treats NULLs as
-- distinct in a unique index, so any number of manager assignments (coachId IS NULL) coexist.
DROP INDEX IF EXISTS "staff_role_assignments_coachId_idx";
CREATE UNIQUE INDEX "staff_role_assignments_coachId_key"
  ON "staff_role_assignments"("coachId");
