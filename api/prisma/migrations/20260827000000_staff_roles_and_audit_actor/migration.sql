-- Academy staff roles & permissions: Owner -> Manager -> Teacher.
-- See ai-usage/final-app/plan/academy-staff-roles.md
--
-- Until now an academy was ONE login with unrestricted access to the whole brand:
-- `academy_accounts` is a single login per group, `coaches` is a profile record with no login,
-- and role was expressed by which app you installed. This lands the whole schema pass in one
-- migration -- both the Manager and the Teacher slice's tables -- deliberately, so the auth
-- tables are not migrated twice. NOTHING here is enforced yet: no guard, route or client reads
-- these tables in this change, and `academy_accounts` remains the only thing that can log in.
--
-- `staff_accounts` is a SECOND, PARALLEL academy-side identity rather than a column on
-- `academy_accounts` or `coaches`: a coach floats between branches by design and a login needs
-- status, invite lifecycle and branch scope that have nothing to do with a teaching profile,
-- while re-pointing owner identity would fragment `academy_settings` (keyed per login).

-- ---------- new enums ----------
CREATE TYPE "StaffStatus" AS ENUM ('invited', 'active', 'deactivated');
CREATE TYPE "PermissionScope" AS ENUM ('academy', 'branch', 'assigned');
CREATE TYPE "AuditActorRole" AS ENUM ('admin', 'academy', 'staff', 'system');

-- A polymorphic `subjectId` on refresh_tokens / expo_push_tokens needs an unambiguous subject
-- table. NOTE this is NOT the JWT `role` claim: a staff login still mints role:'academy'
-- (that claim means "academy-side audience", not "owner"), which is what keeps the ~77 existing
-- academy handlers untouched.
ALTER TYPE "SubjectRole" ADD VALUE IF NOT EXISTS 'staff';

-- ---------- staff_accounts: the non-owner login ----------
-- The auth columns mirror academy_accounts so staff OAuth is later a SERVICE change and not a
-- second migration. Staff login is OTP-only for now.
CREATE TABLE "staff_accounts" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "appleSub" TEXT,
    "googleSub" TEXT,
    "name" TEXT NOT NULL,
    "status" "StaffStatus" NOT NULL DEFAULT 'invited',
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "invitedByAccountId" TEXT,
    "grantsVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_accounts_phone_key" ON "staff_accounts"("phone");
CREATE UNIQUE INDEX "staff_accounts_email_key" ON "staff_accounts"("email");
CREATE UNIQUE INDEX "staff_accounts_appleSub_key" ON "staff_accounts"("appleSub");
CREATE UNIQUE INDEX "staff_accounts_googleSub_key" ON "staff_accounts"("googleSub");
CREATE INDEX "staff_accounts_groupId_idx" ON "staff_accounts"("groupId");

ALTER TABLE "staff_accounts"
  ADD CONSTRAINT "staff_accounts_groupId_fkey" FOREIGN KEY ("groupId")
  REFERENCES "academy_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- staff_roles: the role catalogue ----------
-- System roles are `groupId IS NULL` + `isSystem = true`, shared by every brand, so a new
-- academy needs no per-brand role setup. Custom per-brand roles are later rows with a groupId.
CREATE TABLE "staff_roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_roles_key_groupId_key" ON "staff_roles"("key", "groupId");

ALTER TABLE "staff_roles"
  ADD CONSTRAINT "staff_roles_groupId_fkey" FOREIGN KEY ("groupId")
  REFERENCES "academy_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- staff_role_permissions: role -> permission WITH its scope ----------
-- `permission` is deliberately TEXT and not an enum: adding a permission must not be a
-- migration. `deny` is a flat, absolute denial that beats every grant from every other role
-- assignment -- absence of a grant is the ordinary denial, but effective permissions are the
-- UNION across a staff account's assignments, so without this column "a manager can never
-- issue a refund" is not expressible against a future custom role that re-grants it.
CREATE TABLE "staff_role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "deny" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "staff_role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_role_permissions_roleId_permission_key"
  ON "staff_role_permissions"("roleId", "permission");

ALTER TABLE "staff_role_permissions"
  ADD CONSTRAINT "staff_role_permissions_roleId_fkey" FOREIGN KEY ("roleId")
  REFERENCES "staff_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- staff_role_assignments: one row per role a staff account holds ----------
-- MULTIPLE rows per account are the point: a manager who also coaches is one login, not two.
-- `coachId` is the 'assigned' scope for a teacher assignment (the Coach whose batches they may
-- see) and NULL for a manager assignment.
CREATE TABLE "staff_role_assignments" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "coachId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_role_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_role_assignments_staffId_roleId_key"
  ON "staff_role_assignments"("staffId", "roleId");
CREATE INDEX "staff_role_assignments_coachId_idx" ON "staff_role_assignments"("coachId");

ALTER TABLE "staff_role_assignments"
  ADD CONSTRAINT "staff_role_assignments_staffId_fkey" FOREIGN KEY ("staffId")
  REFERENCES "staff_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "staff_role_assignments"
  ADD CONSTRAINT "staff_role_assignments_roleId_fkey" FOREIGN KEY ("roleId")
  REFERENCES "staff_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "staff_role_assignments"
  ADD CONSTRAINT "staff_role_assignments_coachId_fkey" FOREIGN KEY ("coachId")
  REFERENCES "coaches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- staff_branch_scopes: which branches an assignment reaches ----------
-- This is the scope table plugins/auth.ts step 2 has been reserving space for. Hung off the
-- ASSIGNMENT rather than the account, so "manager @ Andheri + teacher @ Bandra" is expressible
-- without adding a second table later.
CREATE TABLE "staff_branch_scopes" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,

    CONSTRAINT "staff_branch_scopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_branch_scopes_assignmentId_academyId_key"
  ON "staff_branch_scopes"("assignmentId", "academyId");
CREATE INDEX "staff_branch_scopes_academyId_idx" ON "staff_branch_scopes"("academyId");

ALTER TABLE "staff_branch_scopes"
  ADD CONSTRAINT "staff_branch_scopes_assignmentId_fkey" FOREIGN KEY ("assignmentId")
  REFERENCES "staff_role_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "staff_branch_scopes"
  ADD CONSTRAINT "staff_branch_scopes_academyId_fkey" FOREIGN KEY ("academyId")
  REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- academy_group_settings: brand facts off the per-login settings row ----------
-- `academy_settings` is keyed on accountId as its PRIMARY KEY, i.e. one row per login. That is
-- right for notification preferences and quiet hours (a manager and a teacher genuinely want
-- different alerts) and WRONG for contactEmail / contactWhatsapp / privacyShowPhone, which are
-- brand facts read by STUDENT-facing code: left there, the contact details a learner sees would
-- depend on which staff member saved last.
--
-- TRANSITIONAL, deliberately: this table is created and backfilled here, but the columns of the
-- same name on `academy_settings` are STILL the live source. The readers flip and those columns
-- drop in the Manager slice, alongside the PUT /studio/settings permission split -- doing the
-- additive half now means the table exists before the next migration without any behaviour
-- change in this one.
CREATE TABLE "academy_group_settings" (
    "groupId" TEXT NOT NULL,
    "contactEmail" TEXT,
    "contactWhatsapp" TEXT,
    "privacyShowPhone" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "academy_group_settings_pkey" PRIMARY KEY ("groupId")
);

ALTER TABLE "academy_group_settings"
  ADD CONSTRAINT "academy_group_settings_groupId_fkey" FOREIGN KEY ("groupId")
  REFERENCES "academy_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from each group's OLDEST account row. Deterministic, and it matches the existing
-- "oldest branch" tie-break the auth plugin already uses when a group has no default branch.
INSERT INTO "academy_group_settings" ("groupId", "contactEmail", "contactWhatsapp", "privacyShowPhone")
SELECT DISTINCT ON (a."groupId")
       a."groupId", s."contactEmail", s."contactWhatsapp", s."privacyShowPhone"
FROM "academy_accounts" a
JOIN "academy_settings" s ON s."accountId" = a."id"
WHERE a."groupId" IS NOT NULL
ORDER BY a."groupId", a."createdAt" ASC
ON CONFLICT ("groupId") DO NOTHING;

-- Groups whose accounts have no settings row yet still get one, so the table is complete and a
-- reader never has to distinguish "no row" from "not configured".
INSERT INTO "academy_group_settings" ("groupId")
SELECT g."id" FROM "academy_groups" g
ON CONFLICT ("groupId") DO NOTHING;

-- ---------- audit_logs: a polymorphic actor beside the retained adminId ----------
-- An academy-side principal has no adminId, so the actor becomes (actorId, actorRole). NOTE
-- `adminId` is KEPT, not renamed: ~29 Ops-Console call sites pass it and the
-- [adminId, createdAt] index depends on it. It merely becomes nullable.
ALTER TABLE "audit_logs" ALTER COLUMN "adminId" DROP NOT NULL;

-- The two DEFAULTs exist ONLY so a required column could be added to a non-empty table.
-- They are backfilled away immediately below.
-- WARNING: drop both defaults once this has run everywhere -- a silent default on an actor
-- column is how audit rows end up attributed to nobody. Tracked in pre-production-checklist.md.
ALTER TABLE "audit_logs" ADD COLUMN "actorId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "audit_logs" ADD COLUMN "actorRole" "AuditActorRole" NOT NULL DEFAULT 'admin';

-- Denormalised so an academy owner's activity log is one indexed read, instead of joining
-- through five different target types to discover which brand a row belongs to.
ALTER TABLE "audit_logs" ADD COLUMN "groupId" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "academyId" TEXT;

CREATE INDEX "audit_logs_groupId_createdAt_idx" ON "audit_logs"("groupId", "createdAt");

-- Every existing row was written by a Findemy admin.
UPDATE "audit_logs" SET "actorId" = "adminId", "actorRole" = 'admin'
WHERE "actorId" = '' AND "adminId" IS NOT NULL;

-- ---------- academy_settings: drop the brand facts now that readers use the group table ------
-- Ordered AFTER the backfill above, so the values are safely copied before the source columns
-- go. `GET/PUT /studio/settings` now reads and writes contact/privacy through
-- `academy_group_settings`, gated on the owner-only `settings.brand.edit` permission, while
-- notification preferences and quiet hours stay per-login here.
ALTER TABLE "academy_settings" DROP COLUMN "contactEmail";
ALTER TABLE "academy_settings" DROP COLUMN "contactWhatsapp";
ALTER TABLE "academy_settings" DROP COLUMN "privacyShowPhone";
