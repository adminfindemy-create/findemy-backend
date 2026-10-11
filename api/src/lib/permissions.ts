/**
 * The academy-side permission catalogue — the SINGLE source of truth for what an academy
 * principal may do, and the shape the `staff_roles` / `staff_role_permissions` tables are
 * seeded from.
 *
 * Two things depend on this file being the only place the matrix is written down:
 *
 *   1. `prisma/seed-staff-roles.ts` upserts FROM `ROLE_MATRIX` and asserts that no row exists
 *      in the database outside it, so the catalogue and what Postgres actually grants cannot
 *      drift.
 *   2. A mistyped permission argument in a `requireAuth(...)` call becomes a BUILD error rather
 *      than a 403 discovered in staging, because the argument is typed `PermissionKey`.
 *
 * Nothing here is enforced yet. The guard change that reads these tables and the
 * `requireAuth(role, permission)` second argument land with the Manager slice; this file and
 * the seeded rows land first so that slice only has to read them.
 *
 * See ai-usage/final-app/plan/academy-staff-roles.md §3 and §9.2a.
 */

/**
 * How wide a granted permission reaches.
 *
 * Lattice: `assigned` < `branch` < `academy`. When one staff account holds several role
 * assignments, a permission granted by more than one resolves to the WIDEST scope —
 * `max(branch, assigned) = branch`. Mirrors the Prisma `PermissionScope` enum.
 */
export type PermissionScope = 'academy' | 'branch' | 'assigned';

/** The three seeded system roles. Custom roles are later DB rows, not additions here. */
export type RoleKey = 'owner' | 'manager' | 'teacher';

export const ROLE_KEYS: readonly RoleKey[] = ['owner', 'manager', 'teacher'] as const;

export const ROLE_LABELS: Record<RoleKey, string> = {
  owner: 'Owner',
  manager: 'Manager',
  teacher: 'Teacher',
};

type PermissionMeta = {
  /** What the key guards, for the staff-management UI and for whoever reads this next. */
  desc: string;
  /**
   * Declared but with NO live route behind it yet. A reserved key MUST NEVER appear in a
   * `requireAuth(...)` call: no role but owner holds one, so a route gated on it would look
   * guarded while in fact being unreachable for every staff principal. The Manager slice adds
   * a route-coverage test that enforces exactly this.
   */
  reserved?: true;
};

/**
 * Every permission key that exists. `PermissionKey` is derived from this object, so adding a
 * key here is what makes it usable, and removing one breaks the build at its call sites.
 */
export const PERMISSIONS = {
  // --- Overview ---
  'dashboard.view': { desc: 'View the studio dashboard' },
  'inbox.view': { desc: 'View the inbox and activity feed' },

  // --- Brand & branches ---
  'academy.view': { desc: 'View the academy profile' },
  'academy.edit': { desc: 'Edit the academy profile and its images' },
  'branches.view': { desc: 'View the brand’s branches' },
  'branches.create': { desc: 'Create a new branch' },
  'branches.setDefault': { desc: 'Change which branch a login lands on' },

  // --- Catalogue ---
  // `Program` is brand-level MARKETING identity — it hangs off `groupId`, not off a branch — so
  // the three writes carry very different blast radii and get three keys:
  //
  //   `programs.create`  additive. A new program disturbs no existing listing.
  //   `programs.edit`    changes a program on EVERY branch's public listing, including branches
  //                      the actor does not run. Reversible, so a manager may do it.
  //   `programs.delete`  DESTRUCTIVE and brand-wide, and it takes the program's batches with it.
  //                      Owner-only.
  'programs.view': { desc: 'View programs' },
  'programs.create': { desc: 'Create a new program' },
  'programs.edit': { desc: 'Edit a program' },
  'programs.delete': { desc: 'Delete a program' },
  'batches.view': { desc: 'View batches and their rosters' },
  'batches.manage': {
    // Includes the fee fields (`monthly_fee_paise`, `trial_fee_paise`, discount bps) — they are
    // columns on PUT /studio/batches/:id, so there is no separate "fees" key to hold.
    desc: 'Create and edit batches, including their fees and slots',
  },
  'batches.delete': { desc: 'Delete a batch' },
  'batches.discontinue': { desc: 'Start and finish discontinuing a batch' },

  // --- Money ---
  // The single most important denial in the design. This is NOT a reserved key: the route
  // behind it is live and moves real money — POST /studio/batches/:id/discontinuation/refund
  // (modules/discontinuation/routes.ts) issues a pro-rated Razorpay refund on an academy token
  // to buy out a student blocking a batch discontinuation.
  'refunds.issue': { desc: 'Issue a refund to a student' },
  'earnings.view': { desc: 'View earnings and payouts' },
  'finance.kyc': { desc: 'Upload KYC documents and edit bank/financial details' },

  // --- Timetable & classes ---
  'schedule.view': { desc: 'View the class schedule' },
  'sessions.cancel': { desc: 'Cancel a scheduled class' },
  'sessions.live': { desc: 'Start and host a live online class' },

  // --- Attendance ---
  'attendance.view': { desc: 'View attendance registers' },
  'attendance.session.start': { desc: 'Issue the session check-in QR' },
  'attendance.export': { desc: 'Export an attendance register as CSV' },

  // --- People ---
  'students.view': { desc: 'View students and their history' },
  'enrollments.manage': { desc: 'Decide enrollment pause and transfer requests' },
  'trials.view': { desc: 'View trial bookings' },
  'trials.manage': { desc: 'Verify a trial’s attendance code' },
  'coaches.view': { desc: 'View coaches' },
  'coaches.manage': { desc: 'Add, edit and remove coaches' },

  // --- Content ---
  'notes.view': { desc: 'View class notes' },
  'notes.manage': { desc: 'Post and delete class notes and their files' },
  'workshops.view': { desc: 'View workshops and their attendees' },
  'workshops.manage': { desc: 'Create, edit and delete workshops' },
  'events.view': { desc: 'View Findemy-curated events' },
  'reviews.view': { desc: 'View reviews' },
  'reviews.respond': { desc: 'Respond publicly to a review' },
  'media.upload': { desc: 'Upload media' },

  // --- Account ---
  'settings.view': { desc: 'View settings' },
  // Split from `settings.brand.edit` deliberately: PUT /studio/settings mixes a PER-LOGIN fact
  // (notification prefs, quiet hours) with BRAND facts a learner sees. Without the split, the
  // contact number on the public profile would depend on which staff member saved last.
  'me.notifications.edit': { desc: 'Change your own notification preferences' },
  'settings.brand.edit': { desc: 'Change the brand’s public contact details and privacy' },
  'support.use': { desc: 'Use Findemy support chat' },
  'push.register': { desc: 'Register a device for push notifications' },

  // --- Team ---
  'staff.view': { desc: 'View the team' },
  'staff.manage': { desc: 'Invite, edit and deactivate team members and their roles' },
  'audit.view': { desc: 'View the activity/audit log' },

  // Live since the attendance rewrite: the register is correctable for 24h after a class ends.
  // Before that, absence was written 15 minutes after the class and could never be changed.
  'attendance.correct': { desc: 'Correct an attendance record within 24h of the class' },

  // --- RESERVED: declared, no live route yet. See PermissionMeta.reserved. ---
  // Still nothing that edits a record OUTSIDE the 24h window — that is what this would be.
  'attendance.edit': { desc: 'Edit an attendance record with no time limit', reserved: true },
  // Fee fields live on PUT /studio/batches/:id and are covered by `batches.manage`. Reserved
  // for a real fee-structure module, if one is ever built.
  'fees.structure.manage': { desc: 'Manage fee structures', reserved: true },
  // There is no academy-side record-payment endpoint; students pay via Razorpay in the app.
  'payments.record': { desc: 'Record a payment received offline', reserved: true },
  // Refunds are owner-only and flat: no approval step, no amount thresholds.
  'refunds.approve': { desc: 'Approve a refund requested by someone else', reserved: true },
  // Only `attendance.export` exists today.
  'reports.export': { desc: 'Export reports', reserved: true },
} as const satisfies Record<string, PermissionMeta>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isReserved(key: PermissionKey): boolean {
  return (PERMISSIONS[key] as PermissionMeta).reserved === true;
}

/**
 * A single row of `staff_role_permissions`.
 *
 * `deny` is absolute and beats every grant from every other assignment, at every scope. Absence
 * of a grant is the ORDINARY denial; a deny row exists only for keys where absence is not
 * enough, because effective permissions are the union across a staff account's assignments — so
 * a future custom role granting `refunds.issue` would otherwise silently hand a manager the
 * refund button. `scope` is meaningless on a deny row and is stored as `academy` to keep the
 * column non-null.
 */
export type Grant = { scope: PermissionScope; deny?: true };

/** Shorthands, so the matrix below reads like the design doc's table. */
const A: Grant = { scope: 'academy' };
const B: Grant = { scope: 'branch' };
const As: Grant = { scope: 'assigned' };
const DENY: Grant = { scope: 'academy', deny: true };

type RoleGrants = Partial<Record<PermissionKey, Grant>>;

/**
 * OWNER — everything, at brand scope, including the reserved keys (so a reserved key is held by
 * exactly one role and the "no role holds it" invariant that makes it unusable on a route stays
 * true for staff).
 *
 * Built programmatically rather than listed: "the owner can do everything" must not be a list
 * that someone forgets to append to when a permission is added.
 */
const OWNER: RoleGrants = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, A])) as RoleGrants;

/**
 * MANAGER — can run the academy day to day; cannot take it over.
 *
 * The denials ARE the line: no `branches.create`, `batches.delete`, `batches.discontinue`,
 * `earnings.view`, `finance.kyc`, `settings.brand.edit`, `programs.delete`, `staff.manage` or
 * `audit.view` — and an explicit DENY on `refunds.issue`. A manager can operate every day; they
 * cannot see the money, change the bank details, create or destroy branches, delete a batch,
 * DELETE a program, grant themselves a role, or move real money out.
 *
 * They CAN create and edit programs (owner decision, 2026-08-28). The line drawn is
 * reversibility, not reach: an edit is brand-wide but undoable, while a delete is brand-wide,
 * permanent, and takes the program's batches with it.
 */
const MANAGER: RoleGrants = {
  'dashboard.view': B,
  'inbox.view': B,
  'academy.view': B,
  'academy.edit': B,
  'branches.view': B,
  'branches.setDefault': B,
  'programs.view': B,
  // ACADEMY scope, not branch — and forced, not chosen: `Program` has no `academyId`, so a
  // branch-scoped write would have nothing to filter on. Same reason `coaches.manage` is
  // widened below. `programs.delete` is deliberately ABSENT: an edit is brand-wide but
  // reversible, whereas a delete takes the program's batches with it and cannot be undone.
  'programs.create': A,
  'programs.edit': A,
  'batches.view': B,
  'batches.manage': B,
  'refunds.issue': DENY,
  'schedule.view': B,
  'sessions.cancel': B,
  'sessions.live': B,
  'attendance.view': B,
  'attendance.session.start': B,
  'attendance.correct': B,
  'attendance.export': B,
  'students.view': B,
  'enrollments.manage': B,
  'trials.view': B,
  'trials.manage': B,
  'coaches.view': B,
  // Deliberately ACADEMY scope, not branch — and the one flagged widening in the matrix.
  // `Coach` is a brand-level row with no `academyId`, so a branch-scoped write has nothing to
  // filter on, and "branch manager onboards a teacher" is the realistic flow. Every such write
  // is audited.
  'coaches.manage': A,
  'notes.view': B,
  'notes.manage': B,
  'workshops.view': B,
  'workshops.manage': B,
  'events.view': B,
  'reviews.view': B,
  'reviews.respond': B,
  'media.upload': B,
  'settings.view': B,
  'me.notifications.edit': B,
  'support.use': B,
  'push.register': B,
  'staff.view': B,
};

/**
 * TEACHER — classroom work only, on the batches their linked Coach actually teaches.
 *
 * `assigned` scope is what makes "can view students" mean "...students in my own batches". A
 * teacher assignment MUST carry a `coachId`; one without it has an empty assigned scope and
 * must fail closed rather than fall back to the branch.
 *
 * A teacher deliberately holds NO `branches.view` / `programs.view` / `coaches.view`. Those are
 * the brand's directory listings, and a teacher needs none of them: their batch payload carries
 * its program level and coach name inline, and their branch list arrives on `/studio/session`.
 * Granting them would have put Branches, Programs and Coaches rows in a teacher's Studio tab
 * with nothing behind them.
 *
 * `academy.view` and `settings.view` DO stay at `branch` — those back screens a teacher really
 * opens (the academy profile they teach at, and their own notification preferences).
 */
const TEACHER: RoleGrants = {
  'dashboard.view': As,
  'inbox.view': As,
  'academy.view': B,
  'batches.view': As,
  'refunds.issue': DENY,
  'schedule.view': As,
  'sessions.cancel': As,
  'sessions.live': As,
  'attendance.view': As,
  'attendance.session.start': As,
  // A teacher corrects only the register of a batch they actually teach.
  'attendance.correct': As,
  'attendance.export': As,
  'students.view': As,
  'trials.view': As,
  'trials.manage': As,
  'notes.view': As,
  'notes.manage': As,
  // ASSIGNED once more. This was `branch` only because `Workshop` had nothing to filter on —
  // now `WorkshopCoach` says who is conducting it, so a teacher sees the workshops they teach
  // and not the rest of the branch's list with its pricing. They still cannot CHANGE one:
  // `workshops.manage` stays absent.
  'workshops.view': As,
  'reviews.view': As,
  // BRANCH, not assigned: `POST /studio/media/upload` stores under `programs/<groupId>` and
  // takes no batch at all, so there is nothing for an 'assigned' filter to narrow. Class-note
  // attachments — the ones a teacher actually uploads — go through the class-notes routes,
  // which ARE batch-scoped.
  'media.upload': B,
  'settings.view': B,
  'me.notifications.edit': B,
  'push.register': As,
};

export const ROLE_MATRIX: Record<RoleKey, RoleGrants> = {
  owner: OWNER,
  manager: MANAGER,
  teacher: TEACHER,
};

/**
 * Reserved keys are seeded for OWNER only. Asserted here rather than trusted, because a
 * reserved key held by a staff role would make a route gated on it silently passable.
 */
export function assertReservedKeysOwnerOnly(): void {
  for (const role of ['manager', 'teacher'] as const) {
    for (const key of Object.keys(ROLE_MATRIX[role]) as PermissionKey[]) {
      if (isReserved(key) && !ROLE_MATRIX[role][key]?.deny) {
        throw new Error(
          `permissions.ts: reserved key '${key}' is granted to '${role}'. Reserved keys are owner-only.`,
        );
      }
    }
  }
}
