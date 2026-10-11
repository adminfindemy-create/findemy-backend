/**
 * Team management: invite, edit and deactivate the brand's non-owner logins.
 *
 * The invariants Postgres cannot express live here, and each one is a real failure mode rather
 * than defensive noise — see academy-staff-roles.md §7.
 */
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { ROLE_LABELS, type RoleKey } from '../../lib/permissions.js';
import * as repo from './repo.js';

const ASSIGNABLE_ROLES: RoleKey[] = ['manager', 'teacher'];

type StaffRow = Awaited<ReturnType<typeof repo.listStaff>>[number];

function shape(staff: StaffRow) {
  // De-duplicated across assignments: someone who is manager AND teacher at one branch should
  // show that branch once.
  const branches = new Map<string, { id: string; name: string; branch_label: string | null }>();
  for (const a of staff.assignments) {
    for (const b of a.branches) {
      branches.set(b.academyId, {
        id: b.academy.id,
        name: b.academy.name,
        branch_label: b.academy.branchLabel ?? null,
      });
    }
  }
  return {
    id: staff.id,
    name: staff.name,
    phone: staff.phone,
    status: staff.status,
    activated_at: staff.activatedAt?.toISOString() ?? null,
    created_at: staff.createdAt.toISOString(),
    roles: staff.assignments.map((a) => ({
      key: a.role.key,
      label: a.role.label,
      coach: a.coach ? { id: a.coach.id, name: a.coach.name } : null,
    })),
    branches: [...branches.values()],
  };
}

export async function listStaff(groupId: string) {
  const rows = await repo.listStaff(groupId);
  return { items: rows.map(shape) };
}

export async function getStaff(id: string, groupId: string) {
  const staff = await repo.getStaff(id, groupId);
  if (!staff) throw new AppError('NOT_FOUND', 404, 'Team member not found');
  return { staff: shape(staff) };
}

/** The roles an owner may assign, for the invite form. Never includes `owner` (invariant 8). */
export function assignableRoles() {
  return { items: ASSIGNABLE_ROLES.map((key) => ({ key, label: ROLE_LABELS[key] })) };
}

type InviteInput = {
  name: string;
  phone: string;
  role: RoleKey;
  branch_ids: string[];
};

/**
 * Validate an invite or an edit against the invariants. Shared by create and update so the two
 * cannot drift — an edit that could reach a state an invite refuses would be a hole.
 */
async function validate(
  groupId: string,
  input: InviteInput,
  opts: { staffId?: string } = {},
): Promise<{ roleId: string; branchIds: string[] }> {
  // Invariant 8: `staff.manage` must never be a privilege-escalation primitive. Today only
  // owners hold it, so this is defence for the custom-roles phase — but it is cheap and the
  // failure mode (a manager granting themselves owner) is total.
  if (!ASSIGNABLE_ROLES.includes(input.role)) {
    throw new AppError('VALIDATION', 400, 'That role cannot be assigned');
  }

  const role = await repo.getSystemRole(input.role);
  if (!role) throw new AppError('CONFIG', 500, `Role '${input.role}' is not seeded`);

  // Invariant 1: a phone may exist in at most ONE academy-side identity table. Both columns are
  // separately unique, so nothing stops the same number being an owner AND staff — which would
  // make login ambiguous, since the OTP path resolves a principal by phone alone.
  const owner = await repo.findAcademyAccountByPhone(input.phone);
  if (owner) {
    throw new AppError('CONFLICT', 409, 'That number is already an academy owner login');
  }
  const existing = await repo.findStaffByPhoneAnyBrand(input.phone);
  if (existing && existing.id !== opts.staffId) {
    throw new AppError(
      'CONFLICT',
      409,
      existing.groupId === groupId
        ? 'That number is already on your team'
        : 'That number is already a team member at another academy',
    );
  }

  // Invariant 3: an assignment with no branch authenticates but resolves no branch, leaving a
  // login that can see nothing. Refuse to create that state.
  const branchIds = await repo.getBranchIds(groupId, input.branch_ids);
  if (branchIds.length === 0) {
    throw new AppError('VALIDATION', 400, 'Pick at least one branch');
  }
  if (branchIds.length !== new Set(input.branch_ids).size) {
    throw new AppError('VALIDATION', 400, 'One or more branches are not part of your academy');
  }

  // ⚠️ Invariant 2 used to be checked here — "a teacher assignment must carry a coachId" — and
  // it is now satisfied STRUCTURALLY instead: `inviteStaff` creates the Coach in the same
  // transaction as the login, so a teacher without one is unreachable rather than rejected.
  // That is also what removed the `THIS TEACHER IS` picker, which was asking the owner to
  // reconcile two rows describing one person.
  return { roleId: role.id, branchIds };
}

/**
 * Adds a person to the academy — ONE step, whatever they do here.
 *
 * A teacher gets their `Coach` row created in the SAME transaction as their login, carrying the
 * name the owner typed. That is the whole point of this design: there is no moment at which a
 * teacher exists without a teaching profile, and no way to end up with two Coach rows for one
 * person, because a Coach is only ever born here. The teacher fills in the rest themselves —
 * specialty, bio, experience, photo — through `/studio/me/teaching-profile`.
 *
 * `specialty` is NOT NULL on Coach, so it starts as an empty string: the teacher's own profile
 * screen is where it gets a value, and a blank one is what drives the completion prompt.
 */
export async function inviteStaff(groupId: string, invitedByAccountId: string, input: InviteInput) {
  const { roleId, branchIds } = await validate(groupId, input);

  const staff = await prisma.$transaction(async (tx) => {
    const coach =
      input.role === 'teacher'
        ? await tx.coach.create({ data: { groupId, name: input.name, specialty: '' } })
        : null;

    return tx.staffAccount.create({
      data: {
        groupId,
        name: input.name,
        phone: input.phone,
        invitedByAccountId,
        // The phone IS the invite: no link, no email. `invited` flips to `active` on their first
        // successful OTP login (modules/auth/service.ts).
        status: 'invited',
        assignments: {
          create: [
            {
              roleId,
              coachId: coach?.id ?? null,
              branches: { create: branchIds.map((academyId) => ({ academyId })) },
            },
          ],
        },
      },
      include: repo.STAFF_INCLUDE,
    });
  });

  return { staff: shape(staff) };
}

export async function updateStaff(id: string, groupId: string, input: InviteInput) {
  const current = await repo.getStaff(id, groupId);
  if (!current) throw new AppError('NOT_FOUND', 404, 'Team member not found');

  const { roleId, branchIds } = await validate(groupId, input, { staffId: id });

  // ⚠️ The person's teaching profile must SURVIVE this. Assignments are replaced wholesale
  // (see below) and the coach link lives on the assignment — so without carrying it across,
  // every edit to a teacher's branches would quietly strand their profile and empty their scope.
  const existingCoachId = current.assignments.find((a) => a.coach)?.coach?.id ?? null;
  let coachToDelete: string | null = null;

  if (input.role !== 'teacher' && existingCoachId) {
    // Demoted from teacher. Their batches would be left with a coach nobody can log in as, so
    // the batches have to move first; an untaught profile is simply removed with the role.
    const coach = await repo.getCoachBatchCount(existingCoachId, groupId);
    if (coach && coach._count.batches > 0) {
      throw new AppError(
        'CONFLICT',
        409,
        'This person still teaches batches. Reassign those to another teacher before changing their role.',
      );
    }
    coachToDelete = existingCoachId;
  }

  // Assignments are replaced wholesale rather than diffed. With one assignment per staff member
  // today, a diff would be more code for the same result, and a replace cannot leave a stale
  // branch scope behind — which is the failure that actually matters here.
  await prisma.$transaction(async (tx) => {
    await tx.staffRoleAssignment.deleteMany({ where: { staffId: id } });
    if (coachToDelete) await tx.coach.delete({ where: { id: coachToDelete } });

    // Promoted manager -> teacher gets the profile they never had; an existing teacher keeps
    // theirs untouched.
    let linkCoachId = coachToDelete ? null : existingCoachId;
    if (input.role === 'teacher' && !linkCoachId) {
      const coach = await tx.coach.create({ data: { groupId, name: input.name, specialty: '' } });
      linkCoachId = coach.id;
    }
    // One person, one name: a typo the owner fixes here must also fix what students see.
    if (linkCoachId) {
      await tx.coach.update({ where: { id: linkCoachId }, data: { name: input.name } });
    }

    await tx.staffAccount.update({
      where: { id },
      data: {
        name: input.name,
        phone: input.phone,
        // Bumped on every grant change so a later permission cache keyed
        // (staffId, grantsVersion) is safe without a token change.
        grantsVersion: { increment: 1 },
        assignments: {
          create: [
            {
              roleId,
              coachId: linkCoachId,
              branches: { create: branchIds.map((academyId) => ({ academyId })) },
            },
          ],
        },
      },
    });
  });

  const updated = await repo.getStaff(id, groupId);
  return { staff: shape(updated!) };
}

/**
 * Deactivate, never delete (invariant 10). A staff id can already appear in
 * `ClassNote.createdByAccountId`, `Trial.attendanceMarkedByAccountId`,
 * `BatchAttendance.markedByAccountId`, `ClassSession.cancelledByAccountId` and `AuditLog` —
 * all bare `String` columns with no FK, so nothing in the database stops the row being removed
 * and every one of those references silently becoming unresolvable. `deactivated` IS the delete.
 */
export async function deactivateStaff(id: string, groupId: string) {
  const current = await repo.getStaff(id, groupId);
  if (!current) throw new AppError('NOT_FOUND', 404, 'Team member not found');

  await prisma.$transaction([
    prisma.staffAccount.update({
      where: { id },
      data: { status: 'deactivated', deactivatedAt: new Date(), grantsVersion: { increment: 1 } },
    }),
    // The access token is only good for 15 minutes and the guard already fails a deactivated
    // account closed — but leaving a live REFRESH token would let them mint a fresh one right
    // up until it expires 30 days later.
    prisma.refreshToken.updateMany({
      where: { subjectId: id, subjectRole: 'staff', revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  return { ok: true };
}

export async function reactivateStaff(id: string, groupId: string) {
  const current = await repo.getStaff(id, groupId);
  if (!current) throw new AppError('NOT_FOUND', 404, 'Team member not found');
  // Back to `invited`, not `active`: re-activation must go through the same first-login
  // redemption as a fresh invite rather than silently restoring a session.
  await prisma.staffAccount.update({
    where: { id },
    data: { status: 'invited', deactivatedAt: null, grantsVersion: { increment: 1 } },
  });
  return { ok: true };
}
