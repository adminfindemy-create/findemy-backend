import type { Category } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { newId } from '../../lib/id.js';

type OAuthProvider = 'apple' | 'google';

function oauthSubColumn(provider: OAuthProvider): 'appleSub' | 'googleSub' {
  return provider === 'apple' ? 'appleSub' : 'googleSub';
}

export function deriveAvatarInitial(name?: string | null, email?: string | null): string {
  const source = (name ?? email ?? '').trim();
  if (!source) return '??';
  const cleaned = source.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length === 0) return '??';
  return cleaned.slice(0, 2).toUpperCase();
}

export async function findOtpById(id: string) {
  return prisma.otpRequest.findUnique({ where: { id } });
}

export async function createOtpRequest(data: {
  id: string;
  phone: string;
  role: 'student' | 'academy';
  codeHash: string;
  expiresAt: Date;
}) {
  return prisma.otpRequest.create({ data });
}

export async function incrementOtpAttempts(id: string) {
  return prisma.otpRequest.update({
    where: { id },
    data: { attempts: { increment: 1 } },
  });
}

export async function markOtpVerified(id: string) {
  return prisma.otpRequest.update({
    where: { id },
    data: { verified: true },
  });
}

export async function findUserByPhone(phone: string) {
  return prisma.user.findUnique({ where: { phone } });
}

export async function createUser(data: {
  id: string;
  phone: string;
  name: string;
  attendanceOtp: string;
  location: string;
  lat: number;
  lng: number;
  interests: string[];
}) {
  return prisma.user.create({
    data: {
      ...data,
      // `interests` is validated to Category enum values upstream; the cast
      // aligns the type with Prisma's generated `Category[]` input.
      interests: data.interests as Category[],
      avatarInitial: data.name.slice(0, 2).toUpperCase(),
      lastActiveAt: new Date(),
    },
  });
}

export async function updateUserLastActive(id: string) {
  return prisma.user.update({
    where: { id },
    data: { lastActiveAt: new Date() },
  });
}

export async function findAcademyAccountByPhone(phone: string) {
  return prisma.academyAccount.findUnique({
    where: { phone },
    include: { academy: true },
  });
}

export async function findRefreshTokenByHash(hash: string) {
  return prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
}

export async function createRefreshToken(data: {
  id: string;
  subjectId: string;
  subjectRole: 'student' | 'academy';
  tokenHash: string;
  expiresAt: Date;
}) {
  return prisma.refreshToken.create({ data });
}

export async function revokeRefreshTokenByHash(hash: string) {
  return prisma.refreshToken.updateMany({
    where: { tokenHash: hash },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllRefreshTokensForSubject(
  subjectId: string,
  subjectRole: 'student' | 'academy',
) {
  return prisma.refreshToken.updateMany({
    where: { subjectId, subjectRole },
    data: { revokedAt: new Date() },
  });
}

export async function updateOnboarding(
  userId: string,
  data: {
    name: string;
    age?: number;
    location: string;
    lat: number;
    lng: number;
    interests: string[];
  },
) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...data,
      // `interests` is validated to Category enum values upstream; the cast
      // aligns the type with Prisma's generated `Category[]` input.
      interests: data.interests as Category[],
      avatarInitial: data.name.slice(0, 2).toUpperCase(),
      lastActiveAt: new Date(),
    },
  });
}

export async function updateInterests(userId: string, interests: string[]) {
  return prisma.user.update({
    where: { id: userId },
    // `interests` is validated to Category enum values upstream; the cast
    // aligns the type with Prisma's generated `Category[]` input.
    data: { interests: interests as Category[], lastActiveAt: new Date() },
  });
}

// ---------- OAuth: User ----------

export async function findUserByOAuth(provider: OAuthProvider, sub: string) {
  const col = oauthSubColumn(provider);
  return prisma.user.findUnique({ where: { [col]: sub } as any });
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export async function createUserFromOAuth(params: {
  provider: OAuthProvider;
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  attendanceOtp: string;
}) {
  const { provider, sub, email, emailVerified, name, attendanceOtp } = params;
  const data: any = {
    id: newId(),
    name: name ?? null,
    email: email ?? null,
    emailVerified,
    avatarInitial: deriveAvatarInitial(name, email),
    attendanceOtp,
    interests: [],
    lastActiveAt: new Date(),
  };
  data[oauthSubColumn(provider)] = sub;
  return prisma.user.create({ data });
}

export async function linkOAuthToUser(
  userId: string,
  provider: OAuthProvider,
  sub: string,
) {
  const data: any = {};
  data[oauthSubColumn(provider)] = sub;
  return prisma.user.update({ where: { id: userId }, data });
}

// ---------- OAuth: AcademyAccount ----------

export async function findAcademyAccountByOAuth(
  provider: OAuthProvider,
  sub: string,
) {
  const col = oauthSubColumn(provider);
  return prisma.academyAccount.findUnique({
    where: { [col]: sub } as any,
    include: { academy: true },
  });
}

export async function findAcademyAccountByEmail(email: string) {
  return prisma.academyAccount.findUnique({
    where: { email },
    include: { academy: true },
  });
}

export async function createAcademyAccountFromOAuth(params: {
  provider: OAuthProvider;
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}) {
  const { provider, sub, email, emailVerified, name } = params;
  const data: any = {
    id: newId(),
    email: email ?? null,
    emailVerified,
    ownerName: name ?? null,
  };
  data[oauthSubColumn(provider)] = sub;
  const account = await prisma.academyAccount.create({ data });
  return prisma.academyAccount.findUnique({
    where: { id: account.id },
    include: { academy: true },
  });
}

export async function createAcademyAccountFromPhone(params: { phone: string }) {
  const account = await prisma.academyAccount.create({
    data: {
      id: newId(),
      phone: params.phone,
    },
  });
  return prisma.academyAccount.findUnique({
    where: { id: account.id },
    include: { academy: true },
  });
}

export async function linkOAuthToAcademyAccount(
  accountId: string,
  provider: OAuthProvider,
  sub: string,
) {
  const data: any = {};
  data[oauthSubColumn(provider)] = sub;
  await prisma.academyAccount.update({ where: { id: accountId }, data });
  return prisma.academyAccount.findUnique({
    where: { id: accountId },
    include: { academy: true },
  });
}

export async function findAcademyAccountById(id: string) {
  return prisma.academyAccount.findUnique({
    where: { id },
    include: { academy: true },
  });
}

export async function createAcademyAndLink(params: {
  accountId: string;
  academyName: string;
  city: string;
  category: Category;
  ownerName: string | null;
  phone: string | null;
  modesOffered?: ('in_studio' | 'online' | 'home_visit')[];
  tagline?: string | null;
}) {
  const { accountId, academyName, city, category, ownerName, phone, modesOffered, tagline } = params;

  return prisma.$transaction(async (tx) => {
    const academy = await tx.academy.create({
      data: {
        name: academyName,
        category,
        address: city,
        lat: null,
        lng: null,
        verified: false,
        tagline: tagline ?? null,
        modesOffered: (modesOffered ?? []) as any,
      },
    });

    const account = await tx.academyAccount.update({
      where: { id: accountId },
      data: {
        academyId: academy.id,
        ownerName,
        phone,
      },
      include: { academy: true },
    });

    return { account, academy };
  });
}

export async function findMyEnrollments(userId: string) {
  const rows = await prisma.enrollment.findMany({
    where: { userId, status: 'active' },
    include: {
      batch: {
        select: {
          id: true,
          title: true,
          category: true,
          level: true,
          monthlyFeePaise: true,
          status: true,
          mode: true,
          academy: { select: { id: true, name: true, address: true } },
          coach: { select: { id: true, name: true } },
          timings: true,
        },
      },
    },
    orderBy: { startedAt: 'desc' },
  });

  const withAttended = await Promise.all(
    rows.map(async (e) => {
      const attended = await prisma.trial.count({
        where: { userId, batchId: e.batchId, status: 'attended' },
      });
      return { ...e, attended_count: attended };
    }),
  );
  return withAttended;
}

// S3.1: all enrolments (active + past), enrolled batches only — NO trials. `attended_count`
// counts real class attendance (BatchAttendance), not trials. Periods split active/past.
export async function findMyClasses(userId: string) {
  const rows = await prisma.enrollment.findMany({
    where: { userId },
    include: {
      batch: {
        select: {
          id: true,
          title: true,
          category: true,
          level: true,
          monthlyFeePaise: true,
          status: true,
          mode: true,
          academy: { select: { id: true, name: true, address: true } },
          coach: { select: { id: true, name: true } },
          timings: true,
        },
      },
      periods: { select: { status: true, endDate: true, packageType: true }, orderBy: { endDate: 'desc' } },
    },
    orderBy: { startedAt: 'desc' },
  });

  return Promise.all(
    rows.map(async (e) => {
      const attended = await prisma.batchAttendance.count({
        where: { userId, batchId: e.batchId, present: true },
      });
      return { ...e, attended_count: attended };
    }),
  );
}
