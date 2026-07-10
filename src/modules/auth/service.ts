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
import * as repo from './repo.js';
import { prisma } from '../../lib/prisma.js';
import { verifyApple } from './oauth/apple-verifier.js';
import { verifyGoogle } from './oauth/google-verifier.js';

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
    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      user = await repo.createUser({
        id: newId(),
        phone: otp.phone,
        name: 'Student',
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
      is_new_user: isNewUser,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        age: user.age,
        location: user.location,
        lat: user.lat,
        lng: user.lng,
        interests: user.interests,
        avatar_initial: user.avatarInitial,
        created_at: user.createdAt.toISOString(),
        last_active_at: user.lastActiveAt.toISOString(),
      },
    };
  }

  // academy
  let account = await repo.findAcademyAccountByPhone(otp.phone);
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
    // academyId is String? in Prisma; null and undefined are treated
    // identically by issueTokens (absent academy).
    academyId: account.academyId ?? undefined,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    is_new_user: isNewUser,
    account: {
      id: account.id,
      phone: account.phone,
      academy_id: account.academyId,
      owner_name: account.ownerName,
      email: account.email,
      created_at: account.createdAt.toISOString(),
    },
    academy: account.academy
      ? {
          id: account.academy.id,
          name: account.academy.name,
          category: account.academy.category,
          address: account.academy.address,
          lat: account.academy.lat,
          lng: account.academy.lng,
          rating: account.academy.rating,
          bio: account.academy.bio,
          images: [],
        }
      : null,
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
      is_new_user: isNewUser,
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
    academyId: account.academyId ?? undefined,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    is_new_user: isNewUser,
    account: {
      id: account.id,
      phone: account.phone,
      email: account.email,
      owner_name: account.ownerName,
      academy_id: account.academyId,
      name: account.academy?.name ?? null,
      created_at: account.createdAt.toISOString(),
    },
    academy: account.academy
      ? {
          id: account.academy.id,
          name: account.academy.name,
          category: account.academy.category,
          address: account.academy.address,
          lat: account.academy.lat,
          lng: account.academy.lng,
          rating: account.academy.rating,
          bio: account.academy.bio,
          images: [],
        }
      : null,
  };
}

async function issueTokens({
  subjectId,
  role,
  academyId,
}: {
  subjectId: string;
  role: 'student' | 'academy';
  academyId?: string;
}) {
  const accessToken = await signAccessToken({
    sub: subjectId,
    role,
    academy_id: academyId,
  });
  const rawRefresh = generateRefreshToken();
  const tokenHash = hashToken(rawRefresh);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await repo.createRefreshToken({
    id: newId(),
    subjectId,
    subjectRole: role,
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
  const storedRefreshToken = await repo.findRefreshTokenByHash(tokenHash);

  // Replay detection: a refresh token is single-use (rotated on every call). If someone
  // presents one that's already been revoked, either the legitimate owner rotated past it
  // (client retried) or an attacker stole an old token — we can't tell which, so we
  // conservatively assume compromise and kill every session for this subject.
  if (storedRefreshToken && storedRefreshToken.revokedAt) {
    await repo.revokeAllRefreshTokensForSubject(
      storedRefreshToken.subjectId,
      storedRefreshToken.subjectRole as 'student' | 'academy',
    );
    throw new AppError('UNAUTHORIZED', 401, 'Token replay detected');
  }

  if (!storedRefreshToken || storedRefreshToken.expiresAt < new Date()) {
    throw new AppError('UNAUTHORIZED', 401, 'Invalid refresh token');
  }

  await repo.revokeRefreshTokenByHash(tokenHash);

  const newRawRefreshToken = generateRefreshToken();
  const newTokenHash = hashToken(newRawRefreshToken);
  const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await repo.createRefreshToken({
    id: newId(),
    subjectId: storedRefreshToken.subjectId,
    subjectRole: storedRefreshToken.subjectRole as 'student' | 'academy',
    tokenHash: newTokenHash,
    expiresAt: newExpiresAt,
  });

  let academyId: string | undefined;
  if (storedRefreshToken.subjectRole === 'academy') {
    const account = await prisma.academyAccount.findUnique({
      where: { id: storedRefreshToken.subjectId },
    });
    // academyId is String? in Prisma; coalesce null to undefined to match
    // the `string | undefined` target (treated identically downstream).
    academyId = account?.academyId ?? undefined;
  }

  const accessToken = await signAccessToken({
    sub: storedRefreshToken.subjectId,
    role: storedRefreshToken.subjectRole,
    academy_id: academyId,
  });

  return { access_token: accessToken, refresh_token: newRawRefreshToken };
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
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('NOT_FOUND', 404, 'User not found');
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
      avatar_initial: user.avatarInitial,
      created_at: user.createdAt.toISOString(),
      last_active_at: user.lastActiveAt.toISOString(),
    },
    // Each student has a standing 4-digit code an academy coach enters to mark
    // them present at a trial/class, independent of the OTP login flow above.
    attendance_otp: user.attendanceOtp,
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
      avatar_initial: user.avatarInitial,
      created_at: user.createdAt.toISOString(),
      last_active_at: user.lastActiveAt.toISOString(),
    },
  };
}

export async function updateInterests({
  userId,
  interests,
}: {
  userId: string;
  interests: string[];
}) {
  const user = await repo.updateInterests(userId, interests);
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
      avatar_initial: user.avatarInitial,
      created_at: user.createdAt.toISOString(),
      last_active_at: user.lastActiveAt.toISOString(),
    },
  };
}

type AcademyCategory = 'music' | 'dance' | 'arts' | 'yoga';

function shapeAcademyAccount(account: {
  id: string;
  phone: string | null;
  email: string | null;
  ownerName: string | null;
  academyId: string | null;
  academy?: { name: string } | null;
  createdAt: Date;
}) {
  return {
    id: account.id,
    phone: account.phone,
    email: account.email,
    owner_name: account.ownerName,
    academy_id: account.academyId,
    name: account.academy?.name ?? null,
    created_at: account.createdAt.toISOString(),
  };
}

function shapeAcademy(academy: {
  id: string;
  name: string;
  category: string;
  address: string;
  lat: number | null;
  lng: number | null;
  rating: number;
  bio: string | null;
  tagline?: string | null;
  modesOffered?: string[];
}) {
  return {
    id: academy.id,
    name: academy.name,
    category: academy.category,
    address: academy.address,
    lat: academy.lat,
    lng: academy.lng,
    rating: academy.rating,
    bio: academy.bio,
    tagline: academy.tagline ?? null,
    modes_offered: academy.modesOffered ?? [],
    images: [] as string[],
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

  // Idempotent: if academy is already linked, return current state unchanged.
  if (account.academyId && account.academy) {
    return {
      account: shapeAcademyAccount(account),
      academy: shapeAcademy(account.academy),
    };
  }

  const { account: updatedAccount, academy: newAcademy } =
    await repo.createAcademyAndLink({
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
    academy: shapeAcademy(newAcademy),
  };
}

export async function getMyEnrollments({ userId }: { userId: string }) {
  const rows = await repo.findMyEnrollments(userId);
  return {
    items: rows.map((e) => ({
      id: e.id,
      batch_id: e.batchId,
      batch_title: e.batch.title,
      category: e.batch.category,
      level: e.batch.level,
      monthly_fee_paise: e.batch.monthlyFeePaise,
      status: e.status,
      started_at: e.startedAt.toISOString(),
      attended_count: e.attended_count,
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
export async function getMyClasses({ userId }: { userId: string }) {
  const rows = await repo.findMyClasses(userId);
  const today = new Date();

  const toItem = (e: (typeof rows)[number]) => {
    const hasActivePeriod = e.periods.some((p) => p.status === 'active' || p.status === 'grace');
    const isPaused = !!e.pausedUntil && e.pausedUntil > today;
    const itemStatus: 'active' | 'paused' | 'past' =
      e.status !== 'active' || !hasActivePeriod ? 'past' : isPaused ? 'paused' : 'active';
    return {
      enrollment_id: e.id,
      batch_id: e.batchId,
      batch_title: e.batch.title,
      category: e.batch.category,
      level: e.batch.level,
      monthly_fee_paise: e.batch.monthlyFeePaise,
      status: itemStatus,
      // Batch discontinuation lifecycle — student app shows a "Closing" banner + disables renew.
      batch_status: e.batch.status,
      started_at: e.startedAt.toISOString(),
      current_period_end: e.periods[0]?.endDate?.toISOString(),
      paused_until: isPaused ? e.pausedUntil?.toISOString() : undefined,
      attended_count: e.attended_count,
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

