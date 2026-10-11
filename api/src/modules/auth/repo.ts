import type { Category } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { newId } from '../../lib/id.js';
import { selfLearnerCreate } from '../../lib/learner-access.js';

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
  const avatarInitial = data.name.slice(0, 2).toUpperCase();
  return prisma.user.create({
    data: {
      ...data,
      // `interests` is validated to Category enum values upstream; the cast
      // aligns the type with Prisma's generated `Category[]` input.
      interests: data.interests as Category[],
      avatarInitial,
      lastActiveAt: new Date(),
      ...selfLearnerCreate({ name: data.name, avatarInitial, attendanceOtp: data.attendanceOtp }),
    },
  });
}

export async function updateUserLastActive(id: string) {
  return prisma.user.update({
    where: { id },
    data: { lastActiveAt: new Date() },
  });
}

// One include for every account read: the brand, its branches (for the switcher and for
// resolving a single-branch group), and the account's landing branch.
export const ACCOUNT_INCLUDE = {
  group: {
    include: {
      branches: { orderBy: { createdAt: 'asc' } },
    },
  },
  defaultAcademy: true,
} as const;

// The branch an account lands on with no `X-Branch-Id`: its explicit default, else the
// group's only (or oldest) branch. Mirrors step 3 of plugins/auth.ts so the login response
// and the request-time resolution can never disagree.
export function resolveLandingBranch<
  T extends {
    defaultAcademy?: { id: string } | null;
    group?: { branches: { id: string }[] } | null;
  },
>(account: T) {
  if (account.defaultAcademy) return account.defaultAcademy;
  return account.group?.branches[0] ?? null;
}

export async function findAcademyAccountByPhone(phone: string) {
  return prisma.academyAccount.findUnique({
    where: { phone },
    include: ACCOUNT_INCLUDE,
  });
}

// ---------- Staff (non-owner) academy logins ----------

// A staff login carries its own branch scope, so the switcher must be built from the branches
// this SUBJECT holds, not from every branch of the brand. Assignments are the only source of
// that scope — see academy-staff-roles.md §5.3.
export const STAFF_INCLUDE = {
  group: true,
  assignments: {
    include: { branches: { include: { academy: true } } },
  },
} as const;

export async function findStaffAccountByPhone(phone: string) {
  return prisma.staffAccount.findUnique({ where: { phone }, include: STAFF_INCLUDE });
}

export async function findStaffAccountById(id: string) {
  return prisma.staffAccount.findUnique({ where: { id }, include: STAFF_INCLUDE });
}

// The phone IS the invite: there is no invite link and no email, so redeeming it is simply the
// first successful OTP login. Idempotent — an already-active account keeps its original
// `activatedAt` rather than having it bumped on every sign-in.
export async function activateStaffAccount(id: string) {
  return prisma.staffAccount.updateMany({
    where: { id, status: 'invited' },
    data: { status: 'active', activatedAt: new Date() },
  });
}

export async function findRefreshTokenByHash(hash: string) {
  return prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
}

export async function createRefreshToken(data: {
  id: string;
  subjectId: string;
  // 'staff' distinguishes a StaffAccount subject from an AcademyAccount one. Both mint
  // role:'academy' ACCESS tokens, so without this the refresh path could not tell which table
  // to re-read for the subject's group.
  subjectRole: 'student' | 'academy' | 'staff';
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
  subjectRole: 'student' | 'academy' | 'staff',
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
  const avatarInitial = data.name.slice(0, 2).toUpperCase();
  const [user] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        ...data,
        // `interests` is validated to Category enum values upstream; the cast
        // aligns the type with Prisma's generated `Category[]` input.
        interests: data.interests as Category[],
        avatarInitial,
        lastActiveAt: new Date(),
      },
    }),
    // The self learner is the account holder in the register, so it carries the same name.
    prisma.learner.updateMany({ where: { selfOf: { id: userId } }, data: { name: data.name, avatarInitial } }),
  ]);
  return user;
}

export async function updateInterests(userId: string, interests: string[], artForms?: string[]) {
  return prisma.user.update({
    where: { id: userId },
    // `interests` is validated to Category enum values upstream; the cast
    // aligns the type with Prisma's generated `Category[]` input.
    data: {
      interests: interests as Category[],
      ...(artForms !== undefined && { artForms }),
      lastActiveAt: new Date(),
    },
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
    ...selfLearnerCreate({ name, avatarInitial: deriveAvatarInitial(name, email), attendanceOtp }),
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
    include: ACCOUNT_INCLUDE,
  });
}

export async function findAcademyAccountByEmail(email: string) {
  return prisma.academyAccount.findUnique({
    where: { email },
    include: ACCOUNT_INCLUDE,
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
    include: ACCOUNT_INCLUDE,
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
    include: ACCOUNT_INCLUDE,
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
    include: ACCOUNT_INCLUDE,
  });
}

export async function findAcademyAccountById(id: string) {
  return prisma.academyAccount.findUnique({
    where: { id },
    include: ACCOUNT_INCLUDE,
  });
}

// Academy onboarding. Creates the whole spine in one transaction — the brand, its first
// financial entity (the payee), and its first branch — then links the login to the GROUP and
// points its default at that branch. Adding branch #2 later reuses this entity and re-authors
// nothing (see the add-branch flow in modules/studio).
export async function createAcademyGroupAndLink(params: {
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
    const group = await tx.academyGroup.create({
      data: { name: academyName, category, categories: [category], tagline: tagline ?? null },
    });

    const financialEntity = await tx.financialEntity.create({
      data: { groupId: group.id, label: academyName },
    });

    const academy = await tx.academy.create({
      data: {
        groupId: group.id,
        financialEntityId: financialEntity.id,
        // The first branch has no label yet — its display name is just the brand name, and
        // the owner names it when a second branch makes the distinction meaningful.
        branchLabel: null,
        name: academyName,
        category,
        // Discovery filters on `categories`, so a branch created without it would be
        // unfindable under its own art form. The owner can add more from the profile screen.
        categories: [category],
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
        groupId: group.id,
        defaultAcademyId: academy.id,
        ownerName,
        phone,
      },
      include: ACCOUNT_INCLUDE,
    });

    return { account, academy, group, financialEntity };
  });
}

// `learnerId` narrows to one child; omitted → every learner on the account.
export async function findMyEnrollments(userId: string, learnerId?: string) {
  const rows = await prisma.enrollment.findMany({
    where: { userId, status: 'active', ...(learnerId ? { learnerId } : {}) },
    include: {
      learner: { select: { id: true, name: true } },
      batch: {
        select: {
          id: true,
          title: true,
          category: true,
          name: true,
          minAge: true,
          maxAge: true,
          sessionFormat: true,
          gender: true,
          // `level` moved to Program; the student's class cards still show it.
          program: { select: { level: true } },
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
        where: { learnerId: e.learnerId, batchId: e.batchId, status: 'attended' },
      });
      return { ...e, attended_count: attended };
    }),
  );
  return withAttended;
}

// S3.1: all enrolments (active + past), enrolled batches only — NO trials. `attended_count`
// counts real class attendance (BatchAttendance), not trials. Periods split active/past.
export async function findMyClasses(userId: string, learnerId?: string) {
  const rows = await prisma.enrollment.findMany({
    where: { userId, ...(learnerId ? { learnerId } : {}) },
    include: {
      learner: { select: { id: true, name: true } },
      batch: {
        select: {
          id: true,
          title: true,
          category: true,
          name: true,
          minAge: true,
          maxAge: true,
          sessionFormat: true,
          gender: true,
          // `level` moved to Program; the student's class cards still show it.
          program: { select: { level: true } },
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
        where: { learnerId: e.learnerId, batchId: e.batchId, present: true },
      });
      return { ...e, attended_count: attended };
    }),
  );
}
