import { prisma } from '../../lib/prisma.js';

export async function upsertPushToken(data: {
  subjectId: string;
  subjectRole: 'student' | 'academy';
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

// Academy push tokens register under the AcademyAccount id (the login `sub`), but callers
// naturally hold the Academy id. Resolve Academy.id → AcademyAccount.id so pushes land.
export async function resolveAcademyAccountId(academyId: string): Promise<string | null> {
  const account = await prisma.academyAccount.findUnique({
    where: { academyId },
    select: { id: true },
  });
  return account?.id ?? null;
}
