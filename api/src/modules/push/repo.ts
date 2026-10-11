import { prisma } from '../../lib/prisma.js';

export async function upsertPushToken(data: {
  subjectId: string;
  subjectRole: 'student' | 'academy' | 'staff';
  token: string;
  platform: 'ios' | 'android';
}) {
  return prisma.expoPushToken.upsert({
    where: { token: data.token },
    create: {
      id: crypto.randomUUID(),
      ...data,
      lastSeenAt: new Date(),
    },
    update: { lastSeenAt: new Date(), subjectId: data.subjectId, subjectRole: data.subjectRole },
  });
}

export async function deletePushToken(token: string) {
  return prisma.expoPushToken.deleteMany({ where: { token } });
}

export async function findPushTokens(subjectId: string, subjectRole: 'student' | 'academy') {
  return prisma.expoPushToken.findMany({
    where: { subjectId, subjectRole },
  });
}

// All registered device tokens for one or more subject roles — the target set for a broadcast.
export async function findTokensForRoles(roles: ('student' | 'academy')[]) {
  return prisma.expoPushToken.findMany({
    where: { subjectRole: { in: roles } },
    select: { token: true, subjectId: true },
  });
}

// Academy push tokens register under the AcademyAccount id (the login `sub`), but callers
// naturally hold the Academy id — which is now a BRANCH. A brand may hold several logins, so
// this resolves branch → group → every account in that group and returns them ALL.
//
// This replaced a `findUnique({ where: { academyId } })` that depended on the old
// `AcademyAccount.academyId @unique`. When that column became `groupId` the unique lookup
// stopped compiling — which is the only reason every academy-directed push did not silently
// stop resolving.
//
// ⚠️ Returning EVERY account in the group was right when a group meant one login. Extended
// naively to staff it becomes over-broad in a way that matters: a Bandra manager would get
// Andheri's trial alerts. So owners still fan out group-wide (an owner IS group-wide), while
// staff are filtered to the ones whose branch scope actually contains this branch.
//
// This function stays the single fan-out chokepoint. Filtering at each caller instead would
// mean every future notification site has to remember to do it.
export type PushRecipient = { id: string; subjectRole: 'academy' | 'staff' };

export async function resolveAcademyRecipients(academyId: string): Promise<PushRecipient[]> {
  const branch = await prisma.academy.findUnique({
    where: { id: academyId },
    select: { groupId: true },
  });
  if (!branch) return [];

  const [owners, staff] = await Promise.all([
    prisma.academyAccount.findMany({
      where: { groupId: branch.groupId },
      select: { id: true },
    }),
    prisma.staffAccount.findMany({
      where: {
        groupId: branch.groupId,
        // A deactivated login must stop receiving the brand's notifications, not merely stop
        // being able to open them.
        status: 'active',
        assignments: { some: { branches: { some: { academyId } } } },
      },
      select: { id: true },
    }),
  ]);

  return [
    ...owners.map((o) => ({ id: o.id, subjectRole: 'academy' as const })),
    ...staff.map((s) => ({ id: s.id, subjectRole: 'staff' as const })),
  ];
}

// Push tokens for several subjects at once — the fan-out target set for a brand's logins.
export async function findPushTokensForSubjects(
  subjectIds: string[],
  subjectRole: 'student' | 'academy',
) {
  if (subjectIds.length === 0) return [];
  return prisma.expoPushToken.findMany({
    where: { subjectId: { in: subjectIds }, subjectRole },
  });
}

// Same, but for a mixed owner/staff recipient set: the two live under different `subjectRole`
// values, so a single `{ in: ids }` would match a staff id against an owner's tokens.
export async function findPushTokensForRecipients(recipients: PushRecipient[]) {
  if (recipients.length === 0) return [];
  const academyIds = recipients.filter((r) => r.subjectRole === 'academy').map((r) => r.id);
  const staffIds = recipients.filter((r) => r.subjectRole === 'staff').map((r) => r.id);
  return prisma.expoPushToken.findMany({
    where: {
      OR: [
        ...(academyIds.length ? [{ subjectId: { in: academyIds }, subjectRole: 'academy' as const }] : []),
        ...(staffIds.length ? [{ subjectId: { in: staffIds }, subjectRole: 'staff' as const }] : []),
      ],
    },
  });
}

// The branch's display label, for naming the branch in push copy. "A student left a 4★
// review" is useless to an owner with five branches.
export async function findBranchLabel(academyId: string) {
  return prisma.academy.findUnique({
    where: { id: academyId },
    select: { id: true, name: true, branchLabel: true, groupId: true },
  });
}
