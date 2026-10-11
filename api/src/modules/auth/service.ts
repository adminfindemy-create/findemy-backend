import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import { toWireMode } from '../../lib/mode.js';
import {
  generateOtpCode,
  generateAttendanceOtp,
  hashOtp,
  compareOtpHash,
} from '../../lib/otp.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
} from '../../lib/tokens.js';
import { ART_FORMS, type Category } from '@findemy/types';
import * as repo from './repo.js';
import { prisma } from '../../lib/prisma.js';
import { istDateKey } from '../../lib/ist.js';
import { monthRange, statsForBatches } from '../attendance/stats.js';
import { verifyApple } from './oauth/apple-verifier.js';
import { verifyGoogle } from './oauth/google-verifier.js';
import { listLearners } from '../family/service.js';

const OTP_TTL_MS = 5 * 60 * 1000;

export async function requestOtp({
  phone,
  role,
}: {
  phone: string;
  role: 'student' | 'academy';
}) {
  const code = generateOtpCode();
  const otpId = newId();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await repo.createOtpRequest({
    id: otpId,
    phone,
    role,
    codeHash: hashOtp(code),
    expiresAt,
  });

  // In mock mode or without MSG91 key, we just return the OTP ID
  // In production, send SMS via MSG91 here
  if (process.env.MOCK === '1' || !process.env.MSG91_AUTH_KEY) {
    console.log(`[DEV OTP] ${phone} code=${code}`);
  }

  return { otp_id: otpId, expires_at: expiresAt, channel: 'sms' };
}

export async function verifyOtp({
  otp_id,
  code,
}: {
  otp_id: string;
  code: string;
}) {
  const otp = await repo.findOtpById(otp_id);
  if (!otp) throw new AppError('OTP_EXPIRED', 401, 'OTP not found');
  if (otp.expiresAt < new Date()) {
    throw new AppError('OTP_EXPIRED', 401, 'OTP expired');
  }
  if (otp.attempts >= 5) {
    throw new AppError('OTP_INVALID', 401, 'Too many attempts');
  }

  await repo.incrementOtpAttempts(otp_id);

  if (!compareOtpHash(code, otp.codeHash)) {
    throw new AppError('OTP_INVALID', 401, 'Invalid code');
  }

  await repo.markOtpVerified(otp_id);

  if (otp.role === 'student') {
    let user = await repo.findUserByPhone(otp.phone);
    if (!user) {
      user = await repo.createUser({
        id: newId(),
        phone: otp.phone,
        // NO placeholder name. The row is a shell until onboarding fills it, and a placeholder
        // ('Student') would both be shown as the person's real name and make the app's
        // `!user.name` onboarding check dead, leaving `location` as the only gate.
        name: '',
        attendanceOtp: generateAttendanceOtp(),
        location: '',
        lat: 0,
        lng: 0,
        interests: [],
      });
    }
    await repo.updateUserLastActive(user.id);

    const { accessToken, refreshToken } = await issueTokens({
      subjectId: user.id,
      role: 'student',
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      // "New" means "still needs onboarding", not "the row was created just now". The row is
      // created the moment an OTP is verified, so anyone who abandons the profile form is an
      // existing row with an empty profile on their next login: reporting is_new_user=false
      // sent them to the tabs, and the app's onboarding guard bounced them straight back to
      // the profile screen. The client and the guard now agree.
      is_new_user: !user.name || !user.location,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        age: user.age,
        location: user.location,
        lat: user.lat,
        lng: user.lng,
        interests: user.interests,
        art_forms: user.artForms,
        avatar_initial: user.avatarInitial,
        created_at: user.createdAt.toISOString(),
        last_active_at: user.lastActiveAt.toISOString(),
      },
    };
  }

  // academy
  //
  // ⚠️ ORDER IS LOad-BEARING: AcademyAccount -> StaffAccount -> auto-create. An unknown phone
  // auto-creates a brand new empty academy here, so without the StaffAccount lookup FIRST an
  // invited manager's first login would spawn their own empty brand and land in onboarding
  // instead of joining the one that invited them. See academy-staff-roles.md §4.5.
  let account = await repo.findAcademyAccountByPhone(otp.phone);

  if (!account) {
    const staff = await repo.findStaffAccountByPhone(otp.phone);
    if (staff) {
      // A DEACTIVATED staff phone falls through to NEITHER the staff path nor auto-create:
      // silently minting them a fresh academy is far worse than the app's existing "we don't
      // have an academy under this number" copy.
      if (staff.status === 'deactivated') {
        throw new AppError('NOT_FOUND', 404, 'No academy found for this number');
      }
      await repo.activateStaffAccount(staff.id);
      return staffLoginResponse(await repo.findStaffAccountById(staff.id));
    }
  }

  let isNewUser = false;
  if (!account) {
    isNewUser = true;
    account = await repo.createAcademyAccountFromPhone({ phone: otp.phone });
    if (!account) {
      throw new AppError('NOT_FOUND', 500, 'Failed to create academy account');
    }
  }

  const { accessToken, refreshToken } = await issueTokens({
    subjectId: account.id,
    role: 'academy',
    // groupId is String? in Prisma; null and undefined are treated
    // identically by issueTokens (account has not onboarded yet).
    groupId: account.groupId ?? undefined,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    is_new_user: isNewUser,
    account: shapeAcademyAccount(account),
    group: account.group ? shapeGroup(account.group) : null,
    academy: (() => {
      const branch = landingBranch(account);
      return branch ? shapeBranch(branch) : null;
    })(),
  };
}

function getAppleBundleId(role: 'student' | 'academy'): string {
  const id =
    role === 'student'
      ? env.APPLE_STUDENT_BUNDLE_ID
      : env.APPLE_ADMIN_BUNDLE_ID;
  if (!id) {
    throw new AppError(
      'oauth_audience_mismatch',
      401,
      `Apple bundle ID not configured for role=${role}`,
    );
  }
  return id;
}

function getGoogleAudiences(role: 'student' | 'academy'): string[] {
  const ids =
    role === 'student'
      ? [
          env.GOOGLE_STUDENT_IOS_CLIENT_ID,
          env.GOOGLE_STUDENT_ANDROID_CLIENT_ID,
        ]
      : [env.GOOGLE_ADMIN_IOS_CLIENT_ID, env.GOOGLE_ADMIN_ANDROID_CLIENT_ID];
  const filtered = ids.filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (filtered.length === 0) {
    throw new AppError(
      'oauth_audience_mismatch',
      401,
      `Google client IDs not configured for role=${role}`,
    );
  }
  return filtered;
}

export async function loginWithOAuth({
  provider,
  idToken,
  nonce,
  role,
}: {
  provider: 'apple' | 'google';
  idToken: string;
  nonce?: string;
  role: 'student' | 'academy';
}) {
  // 1. Verify token → normalized profile
  const profile =
    provider === 'apple'
      ? await verifyApple({
          idToken,
          nonce,
          bundleId: getAppleBundleId(role),
        })
      : await verifyGoogle({
          idToken,
          allowedAudiences: getGoogleAudiences(role),
        });

  if (role === 'student') {
    // 2. Try lookup by provider sub, then by email, else create
    let user = await repo.findUserByOAuth(provider, profile.sub);
    let isNewUser = false;

    if (!user && profile.email) {
      user = await repo.findUserByEmail(profile.email);
    }

    if (!user) {
      isNewUser = true;
      user = await repo.createUserFromOAuth({
        provider,
        sub: profile.sub,
        email: profile.email,
        emailVerified: profile.emailVerified,
        name: profile.name,
        attendanceOtp: generateAttendanceOtp(),
      });
    } else {
      // Link OAuth sub to existing user if not yet linked
      const subField = provider === 'apple' ? 'appleSub' : 'googleSub';
      const existingSub = (user as Record<string, unknown>)[subField];
      if (!existingSub) {
        user = (await repo.linkOAuthToUser(user.id, provider, profile.sub)) as typeof user;
      }
    }

    await repo.updateUserLastActive(user.id);

    const { accessToken, refreshToken } = await issueTokens({
      subjectId: user.id,
      role: 'student',
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      // Same rule as the OTP path: "new" = the profile is not filled in yet. OAuth gives us a
      // name but never a location, so a returning half-onboarded account must not be routed
      // into the tabs only for the onboarding guard to throw it back out.
      is_new_user: isNewUser || !user.name || !user.location,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        age: user.age,
        location: user.location,
        lat: user.lat,
        lng: user.lng,
        interests: user.interests,
        art_forms: user.artForms,
        avatar_initial: user.avatarInitial,
        created_at: user.createdAt.toISOString(),
        last_active_at: user.lastActiveAt.toISOString(),
      },
    };
  }

  // 3. role === 'academy'
  let account = await repo.findAcademyAccountByOAuth(provider, profile.sub);
  let isNewUser = false;

  if (!account && profile.email) {
    account = await repo.findAcademyAccountByEmail(profile.email);
  }

  if (!account) {
    isNewUser = true;
    account = await repo.createAcademyAccountFromOAuth({
      provider,
      sub: profile.sub,
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
    });
  } else {
    const subField = provider === 'apple' ? 'appleSub' : 'googleSub';
    const existingSub = (account as Record<string, unknown>)[subField];
    if (!existingSub) {
      account = await repo.linkOAuthToAcademyAccount(
        account.id,
        provider,
        profile.sub,
      );
    }
  }

  if (!account) {
    throw new AppError('INTERNAL', 500, 'Failed to create academy account');
  }

  const { accessToken, refreshToken } = await issueTokens({
    subjectId: account.id,
    role: 'academy',
    groupId: account.groupId ?? undefined,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    is_new_user: isNewUser,
    account: shapeAcademyAccount(account),
    group: account.group ? shapeGroup(account.group) : null,
    academy: (() => {
      const branch = landingBranch(account);
      return branch ? shapeBranch(branch) : null;
    })(),
  };
}

async function issueTokens({
  subjectId,
  role,
  groupId,
  subKind,
}: {
  subjectId: string;
  role: 'student' | 'academy';
  groupId?: string;
  // 'staff' means `subjectId` is a StaffAccount. The ACCESS token still says role:'academy'
  // (the claim names the audience, not the privilege level) while the REFRESH row is stored
  // under subjectRole 'staff', because on refresh we must know which table to re-read.
  subKind?: 'owner' | 'staff';
}) {
  const accessToken = await signAccessToken({
    sub: subjectId,
    role,
    sub_kind: subKind,
    group_id: groupId,
  });
  const rawRefresh = generateRefreshToken();
  const tokenHash = hashToken(rawRefresh);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await repo.createRefreshToken({
    id: newId(),
    subjectId,
    subjectRole: subKind === 'staff' ? 'staff' : role,
    tokenHash,
    expiresAt,
  });

  return { accessToken, refreshToken: rawRefresh };
}

export async function refresh({
  refreshToken,
}: {
  refreshToken: string;
}) {
  const tokenHash = hashToken(refreshToken);
  const rt = await repo.findRefreshTokenByHash(tokenHash);

  // Replay detection: if token is already revoked, assume compromise and revoke all
  if (rt && rt.revokedAt) {
    await repo.revokeAllRefreshTokensForSubject(
      rt.subjectId,
      rt.subjectRole as 'student' | 'academy' | 'staff',
    );
    throw new AppError('UNAUTHORIZED', 401, 'Token replay detected');
  }

  if (!rt || rt.expiresAt < new Date()) {
    throw new AppError('UNAUTHORIZED', 401, 'Invalid refresh token');
  }

  await repo.revokeRefreshTokenByHash(tokenHash);

  const newRaw = generateRefreshToken();
  const newHash = hashToken(newRaw);
  const newExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await repo.createRefreshToken({
    id: newId(),
    subjectId: rt.subjectId,
    subjectRole: rt.subjectRole as 'student' | 'academy' | 'staff',
    tokenHash: newHash,
    expiresAt: newExpires,
  });

  let groupId: string | undefined;
  // ⚠️ `subjectRole` is the SUBJECT TABLE, not the token's role claim. A staff refresh row must
  // still mint role:'academy' — minting role:'staff' would fail every `requireAuth('academy')`
  // guard in the app — with sub_kind naming the table instead.
  const isStaff = rt.subjectRole === 'staff';
  if (rt.subjectRole === 'academy') {
    const account = await prisma.academyAccount.findUnique({
      where: { id: rt.subjectId },
    });
    // groupId is String? in Prisma; coalesce null to undefined to match
    // the `string | undefined` target (treated identically downstream).
    groupId = account?.groupId ?? undefined;
  } else if (isStaff) {
    const staff = await prisma.staffAccount.findUnique({
      where: { id: rt.subjectId },
      select: { groupId: true, status: true },
    });
    // Deactivation revokes refresh tokens, but a race (revoke in flight) must not hand back a
    // fresh 15-minute access token. Fail closed here as well as at the guard.
    if (!staff || staff.status !== 'active') {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid refresh token');
    }
    groupId = staff.groupId;
  }

  const accessToken = await signAccessToken({
    sub: rt.subjectId,
    role: isStaff ? 'academy' : rt.subjectRole,
    sub_kind: isStaff ? 'staff' : undefined,
    group_id: groupId,
  });

  return { access_token: accessToken, refresh_token: newRaw };
}

export async function logout({
  refreshToken,
}: {
  refreshToken: string;
}) {
  const tokenHash = hashToken(refreshToken);
  await repo.revokeRefreshTokenByHash(tokenHash);
}

export async function getMe({ userId }: { userId: string }) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) throw new AppError('NOT_FOUND', 404, 'User not found');
  const { learners } = await listLearners(userId);
  return {
    user: {
      id: u.id,
      phone: u.phone,
      name: u.name,
      age: u.age,
      location: u.location,
      lat: u.lat,
      lng: u.lng,
      interests: u.interests,
      art_forms: u.artForms,
      avatar_initial: u.avatarInitial,
      created_at: u.createdAt.toISOString(),
      last_active_at: u.lastActiveAt.toISOString(),
    },
    // No standing attendance code any more: every class and trial has its own, handed out only
    // in its window (GET /enrollments/:id/attendance-code, and `attendance_code` on a trial).
    learners,
  };
}

export async function getMyStats({ userId }: { userId: string }) {
  const [trialsCount, enrolledCount, reviewsCount] = await Promise.all([
    prisma.trial.count({ where: { userId } }),
    prisma.enrollment.count({ where: { userId, status: 'active' } }),
    prisma.review.count({ where: { userId } }),
  ]);
  return {
    trials_count: trialsCount,
    enrolled_count: enrolledCount,
    reviews_count: reviewsCount,
  };
}

export async function updateOnboarding({
  userId,
  name,
  age,
  location,
  lat,
  lng,
  interests,
}: {
  userId: string;
  name: string;
  age?: number;
  location: string;
  lat: number;
  lng: number;
  interests: string[];
}) {
  const user = await repo.updateOnboarding(userId, {
    name,
    age,
    location,
    lat,
    lng,
    interests,
  });
  return {
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      age: user.age,
      location: user.location,
      lat: user.lat,
      lng: user.lng,
      interests: user.interests,
      art_forms: user.artForms,
      avatar_initial: user.avatarInitial,
      created_at: user.createdAt.toISOString(),
      last_active_at: user.lastActiveAt.toISOString(),
    },
  };
}

export async function updateInterests({
  userId,
  interests,
  art_forms,
}: {
  userId: string;
  interests: string[];
  art_forms?: string[];
}) {
  // Keep only catalogue art forms that belong to a category the student actually picked, so
  // deselecting Music also drops Guitar.
  const artForms = art_forms?.filter((key) =>
    interests.some((cat) => ART_FORMS[cat as Category].some((a) => a.key === key)),
  );
  const user = await repo.updateInterests(userId, interests, artForms ? [...new Set(artForms)] : undefined);
  return {
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      age: user.age,
      location: user.location,
      lat: user.lat,
      lng: user.lng,
      interests: user.interests,
      art_forms: user.artForms,
      avatar_initial: user.avatarInitial,
      created_at: user.createdAt.toISOString(),
      last_active_at: user.lastActiveAt.toISOString(),
    },
  };
}

type AcademyCategory = 'music' | 'dance' | 'arts' | 'yoga';

// The account/group/branch shapes every academy auth response returns. An academy login is
// now a login into a BRAND that owns N branches, so the response carries the group and the
// full branch list (the app's branch switcher reads it) plus the branch this session lands
// on. `academy` is that landing branch — kept under its old key and old shape so no client
// breaks on the day the group lands.
type BranchLike = {
  id: string;
  name: string;
  branchLabel?: string | null;
  category: string;
  address: string;
  lat: number | null;
  lng: number | null;
  rating?: number;
  bio?: string | null;
  tagline?: string | null;
  modesOffered?: string[];
  images?: string[];
  status?: string;
  verified?: boolean;
};

type AccountLike = {
  id: string;
  phone: string | null;
  email: string | null;
  ownerName: string | null;
  groupId: string | null;
  defaultAcademyId?: string | null;
  defaultAcademy?: BranchLike | null;
  group?:
    | ({ id: string; name: string; category: string; bio: string | null; tagline: string | null; specialities: string[] } & {
        branches: BranchLike[];
      })
    | null;
  createdAt: Date;
};

function shapeBranch(branch: BranchLike) {
  return {
    id: branch.id,
    name: branch.name,
    branch_label: branch.branchLabel ?? null,
    category: branch.category,
    address: branch.address,
    lat: branch.lat,
    lng: branch.lng,
    rating: branch.rating ?? 0,
    bio: branch.bio ?? null,
    tagline: branch.tagline ?? null,
    modes_offered: branch.modesOffered ?? [],
    status: branch.status ?? null,
    verified: branch.verified ?? false,
    images: branch.images ?? [],
  };
}

function shapeGroup(group: NonNullable<AccountLike['group']>) {
  return {
    id: group.id,
    name: group.name,
    category: group.category,
    bio: group.bio,
    tagline: group.tagline,
    specialities: group.specialities,
    branches: group.branches.map(shapeBranch),
  };
}

// A staff login's response, shaped so the academy app needs no new branch in its auth store:
// same `{ account, group, academy }` envelope as an owner login.
//
// The one substantive difference is that `group.branches` is narrowed to the branches this
// SUBJECT holds. That is what makes the client's existing stale-active-branch fallback in
// `setBranches` do the right thing for free, and it is why the branch switcher can never offer
// a manager a branch the server would (correctly) 403 on.
async function staffLoginResponse(staff: Awaited<ReturnType<typeof repo.findStaffAccountById>>) {
  if (!staff) throw new AppError('NOT_FOUND', 404, 'No academy found for this number');

  // De-duplicated across assignments: a staff member who is manager AND teacher at the same
  // branch must see that branch once.
  const byId = new Map<string, (typeof staff.assignments)[number]['branches'][number]['academy']>();
  for (const a of staff.assignments) for (const b of a.branches) byId.set(b.academyId, b.academy);
  const branches = [...byId.values()].sort(
    (x, y) => x.createdAt.getTime() - y.createdAt.getTime(),
  );

  const { accessToken, refreshToken } = await issueTokens({
    subjectId: staff.id,
    role: 'academy',
    groupId: staff.groupId,
    subKind: 'staff',
  });

  const landing = branches[0] ?? null;

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    // Never true for staff: the brand already exists, and the client uses this to decide
    // whether to route into onboarding — which would try to create a SECOND brand.
    is_new_user: false,
    account: {
      id: staff.id,
      phone: staff.phone,
      email: staff.email,
      owner_name: staff.name,
      group_id: staff.groupId,
      academy_id: landing?.id ?? null,
      default_academy_id: null,
      name: staff.group.name,
      created_at: staff.createdAt.toISOString(),
    },
    group: shapeGroup({ ...staff.group, branches }),
    academy: landing ? shapeBranch(landing) : null,
  };
}

// The branch this session acts on absent an `X-Branch-Id` header. Identical rule to
// repo.resolveLandingBranch and to step 3 of plugins/auth.ts.
function landingBranch(account: AccountLike): BranchLike | null {
  return account.defaultAcademy ?? account.group?.branches[0] ?? null;
}

function shapeAcademyAccount(account: AccountLike) {
  const branch = landingBranch(account);
  return {
    id: account.id,
    phone: account.phone,
    email: account.email,
    owner_name: account.ownerName,
    group_id: account.groupId,
    // The landing branch, under the key clients already read. An account with a group but
    // no branch yet reports null here and routes to onboarding, same as before.
    academy_id: branch?.id ?? null,
    default_academy_id: account.defaultAcademyId ?? null,
    name: account.group?.name ?? branch?.name ?? null,
    created_at: account.createdAt.toISOString(),
  };
}

export async function completeAcademyOnboarding(params: {
  accountId: string;
  ownerName?: string;
  academyName: string;
  city: string;
  category: AcademyCategory;
  phone?: string;
  modesOffered?: ('in_studio' | 'online' | 'home_visit')[];
  tagline?: string;
}) {
  const { accountId, ownerName, academyName, city, category, phone, modesOffered, tagline } = params;

  const account = await repo.findAcademyAccountById(accountId);
  if (!account) {
    throw new AppError('NOT_FOUND', 404, 'Academy account not found');
  }

  // Idempotent: once the brand exists, return current state unchanged.
  if (account.groupId && account.group) {
    return {
      account: shapeAcademyAccount(account),
      group: shapeGroup(account.group),
      academy: (() => {
        const branch = landingBranch(account);
        return branch ? shapeBranch(branch) : null;
      })(),
    };
  }

  const {
    account: updatedAccount,
    academy: newAcademy,
    group: newGroup,
  } = await repo.createAcademyGroupAndLink({
    accountId: account.id,
    academyName,
    city,
    category,
    ownerName: ownerName ?? account.ownerName ?? null,
    phone: phone ?? account.phone ?? null,
    modesOffered: modesOffered ?? [],
    tagline: tagline ?? null,
  });

  return {
    account: shapeAcademyAccount(updatedAccount),
    group: shapeGroup({ ...newGroup, branches: [newAcademy] }),
    academy: shapeBranch(newAcademy),
  };
}

export async function getMyEnrollments({ userId, learnerId }: { userId: string; learnerId?: string }) {
  const rows = await repo.findMyEnrollments(userId, learnerId);
  // Same month ratio the Classes tab shows, so the class's own screen can't disagree with the list.
  const monthStats = await statsForBatches(
    rows.map((e) => e.batchId),
    monthRange(istDateKey(new Date()).slice(0, 7)),
  );
  return {
    items: rows.map((e) => ({
      id: e.id,
      learner_id: e.learnerId,
      learner: e.learner,
      batch_id: e.batchId,
      batch_title: e.batch.title,
      category: e.batch.category,
      batch_name: e.batch.name,
      level: e.batch.program.level,
      min_age: e.batch.minAge ?? null,
      max_age: e.batch.maxAge ?? null,
      session_format: e.batch.sessionFormat,
      gender: e.batch.gender,
      monthly_fee_paise: e.batch.monthlyFeePaise,
      status: e.status,
      started_at: e.startedAt.toISOString(),
      attended_count: e.attended_count,
      month_present: monthStats.get(e.batchId)?.per_student.find((s) => s.learner_id === e.learnerId)?.present ?? 0,
      month_expected: monthStats.get(e.batchId)?.per_student.find((s) => s.learner_id === e.learnerId)?.expected ?? 0,
      academy_id: e.batch.academy.id,
      academy_name: e.batch.academy.name,
      academy_address: e.batch.academy.address ?? undefined,
      coach_name: e.batch.coach?.name ?? undefined,
      mode: toWireMode(e.batch.mode), // S1.3: canonical Mode ('in-studio'|'online')
      timings: e.batch.timings.map((t) => ({
        day_of_week: t.dayOfWeek,
        start_time: t.startTime,
        duration_min: t.durationMin,
      })),
    })),
  };
}

// S3.1: the student "Classes" tab — enrolled batches only (no trials), split active/past.
export async function getMyClasses({ userId, learnerId }: { userId: string; learnerId?: string }) {
  const rows = await repo.findMyClasses(userId, learnerId);
  const today = new Date();

  // "This month: 9 of 12 classes" — a ratio, never a day-by-day diary. A wrongly-recorded absence
  // cannot be corrected in-app (plan decision 4), and a per-day "ABSENT" in the student's face
  // turns every QR glitch into an argument the academy can't win. The number is still shown
  // because the academy will discuss it at renewal. See plan decision 9.
  const monthStats = await statsForBatches(
    rows.map((e) => e.batchId),
    monthRange(istDateKey(today).slice(0, 7)),
  );
  const monthFigureFor = (batchId: string, learnerId: string) => {
    const stat = monthStats.get(batchId)?.per_student.find((s) => s.learner_id === learnerId);
    return { month_present: stat?.present ?? 0, month_expected: stat?.expected ?? 0 };
  };

  const toItem = (e: (typeof rows)[number]) => {
    const hasActivePeriod = e.periods.some((p) => p.status === 'active' || p.status === 'grace');
    const isPaused = !!e.pausedUntil && e.pausedUntil > today;
    const itemStatus: 'active' | 'paused' | 'past' =
      e.status !== 'active' || !hasActivePeriod ? 'past' : isPaused ? 'paused' : 'active';
    return {
      enrollment_id: e.id,
      learner_id: e.learnerId,
      learner: e.learner,
      batch_id: e.batchId,
      batch_title: e.batch.title,
      category: e.batch.category,
      batch_name: e.batch.name,
      level: e.batch.program.level,
      min_age: e.batch.minAge ?? null,
      max_age: e.batch.maxAge ?? null,
      session_format: e.batch.sessionFormat,
      gender: e.batch.gender,
      monthly_fee_paise: e.batch.monthlyFeePaise,
      status: itemStatus,
      // Batch discontinuation lifecycle — student app shows a "Closing" banner + disables renew.
      batch_status: e.batch.status,
      started_at: e.startedAt.toISOString(),
      current_period_end: e.periods[0]?.endDate?.toISOString(),
      paused_until: isPaused ? e.pausedUntil?.toISOString() : undefined,
      attended_count: e.attended_count,
      ...monthFigureFor(e.batchId, e.learnerId),
      academy_id: e.batch.academy.id,
      academy_name: e.batch.academy.name,
      academy_address: e.batch.academy.address ?? undefined,
      coach_name: e.batch.coach?.name ?? undefined,
      mode: toWireMode(e.batch.mode),
      timings: e.batch.timings.map((t) => ({
        day_of_week: t.dayOfWeek,
        start_time: t.startTime,
        duration_min: t.durationMin,
      })),
    };
  };

  const active: ReturnType<typeof toItem>[] = [];
  const past: ReturnType<typeof toItem>[] = [];
  for (const e of rows) {
    const item = toItem(e);
    (item.status === 'past' ? past : active).push(item);
  }
  return { active, past };
}

