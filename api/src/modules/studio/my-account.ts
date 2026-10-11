/**
 * `GET/PUT /studio/me/account` — who the CALLER is, for every academy-side role.
 *
 * Distinct from two things it sits next to:
 *   - `/studio/academy`          the BRAND's profile — what the business is.
 *   - `/studio/me/teaching-profile`  a teacher's PUBLIC identity — what students see.
 * This one is the person's own account: their name, the number they sign in with, and what
 * they have been given access to.
 *
 * Before this existed, a manager could sign in and find nothing anywhere in the app that said
 * who they were: the Studio header shows the ACADEMY, and the ACCOUNT section's "Phone" row was
 * a dead display with an empty `onPress`.
 *
 * Self-scoped, so no permission key: it reads and writes `req.user.id` and nothing else. An
 * owner resolves to their `AcademyAccount`, staff to their `StaffAccount`.
 */
import type { FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';

export type MyAccount = {
  name: string | null;
  /** The login. Read-only here — see the note on `updateMyAccount`. */
  phone: string | null;
  sub_kind: 'owner' | 'staff';
  roles: { key: string; label: string }[];
  branches: { id: string; name: string; branch_label: string | null }[];
  /** True when this person also has a public teaching profile to edit. */
  has_teaching_profile: boolean;
};

export async function getMyAccount(req: FastifyRequest): Promise<{ account: MyAccount }> {
  const isStaff = req.user.sub_kind === 'staff';

  if (!isStaff) {
    const owner = await prisma.academyAccount.findUnique({
      where: { id: req.user.id },
      select: { ownerName: true, phone: true },
    });
    if (!owner) throw new AppError('NOT_FOUND', 404, 'Account not found');
    return {
      account: {
        name: owner.ownerName,
        phone: owner.phone,
        sub_kind: 'owner',
        roles: [{ key: 'owner', label: 'Owner' }],
        // An owner reaches every branch of their brand, so listing them here would just
        // duplicate the branch switcher.
        branches: [],
        has_teaching_profile: false,
      },
    };
  }

  const staff = await prisma.staffAccount.findUnique({
    where: { id: req.user.id },
    select: {
      name: true,
      phone: true,
      assignments: {
        select: {
          coachId: true,
          role: { select: { key: true, label: true } },
          branches: { include: { academy: { select: { id: true, name: true, branchLabel: true } } } },
        },
      },
    },
  });
  if (!staff) throw new AppError('NOT_FOUND', 404, 'Account not found');

  // De-duplicated: someone holding two assignments at one branch should see it once.
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
    account: {
      name: staff.name,
      phone: staff.phone,
      sub_kind: 'staff',
      roles: staff.assignments.map((a) => ({ key: a.role.key, label: a.role.label })),
      branches: [...branches.values()],
      has_teaching_profile: staff.assignments.some((a) => a.coachId),
    },
  };
}

/**
 * Only the NAME is writable.
 *
 * Not the phone: it is the login credential — the OTP path resolves a principal by phone alone —
 * so changing it has to verify the new number by OTP first and re-check the cross-table
 * uniqueness invariant. That is its own flow, not a text field. Nor the role or branches: those
 * are access, and access is the owner's to grant.
 */
export async function updateMyAccount(req: FastifyRequest, name: string) {
  const isStaff = req.user.sub_kind === 'staff';

  if (!isStaff) {
    await prisma.academyAccount.update({ where: { id: req.user.id }, data: { ownerName: name } });
    return getMyAccount(req);
  }

  await prisma.$transaction(async (tx) => {
    await tx.staffAccount.update({ where: { id: req.user.id }, data: { name } });
    // ONE PERSON, ONE NAME — the same rule `updateStaff` and the teaching profile follow. A
    // teacher renaming themselves here must change what students see too.
    const coachId = req.user.coach_ids?.[0];
    if (coachId) await tx.coach.update({ where: { id: coachId }, data: { name } });
  });

  return getMyAccount(req);
}
