import type { AcademyStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import { env } from '../../lib/env.js';
import { newId } from '../../lib/id.js';
import { signAccessToken, generateRefreshToken, hashToken } from '../../lib/tokens.js';
import { verifyGoogle } from '../auth/oauth/google-verifier.js';
import { sendPushNotifications } from '../push/service.js';
import * as rzpx from '../../lib/razorpayx.js';
import { writeAudit } from './audit.js';
import * as repo from './repo.js';

// ---------- Auth ----------

async function issueAdminTokens(adminId: string) {
  const accessToken = await signAccessToken({ sub: adminId, role: 'admin', perms: [] });
  const rawRefresh = generateRefreshToken();
  await repo.createRefreshToken({
    id: newId(),
    subjectId: adminId,
    tokenHash: hashToken(rawRefresh),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return { access_token: accessToken, refresh_token: rawRefresh };
}

async function loginForEmail(email: string) {
  const admin = await repo.findAdminByEmail(email);
  if (!admin || admin.disabled) {
    // Same error whether the email is unknown or disabled — don't leak the allowlist.
    throw new AppError('FORBIDDEN', 403, 'Not an authorized admin');
  }
  const tokens = await issueAdminTokens(admin.id);
  return { ...tokens, admin: { id: admin.id, email: admin.email, name: admin.name } };
}

// Real path: verify the Google Workspace token, require hd == Findemy domain AND an allowlist row.
export async function adminLoginWithGoogle({ idToken }: { idToken: string }) {
  const audiences = [env.GOOGLE_OPS_WEB_CLIENT_ID].filter(
    (s): s is string => !!s,
  );
  const profile = await verifyGoogle({ idToken, allowedAudiences: audiences });
  if (!profile.email || !profile.emailVerified) {
    throw new AppError('FORBIDDEN', 403, 'Unverified Google account');
  }
  if (profile.hd !== env.FINDEMY_ADMIN_DOMAIN) {
    throw new AppError('FORBIDDEN', 403, 'Not a Findemy Workspace account');
  }
  return loginForEmail(profile.email);
}

// Dev path: sign in by email, still checked against the allowlist. Lets us exercise the full admin
// surface locally without minting real Google Workspace tokens. Enabled by MOCK=1 OR the dedicated
// ADMIN_DEV_LOGIN=1 flag — the latter lets admin login work while the backend runs in REAL mode
// (MOCK=0), so the student app's actions actually hit the DB and become visible in this console.
// Both are dev-only; in production neither is set, leaving Google Workspace SSO as the only path.
export async function adminDevLogin({ email }: { email: string }) {
  if (process.env.MOCK !== '1' && process.env.ADMIN_DEV_LOGIN !== '1') {
    throw new AppError('NOT_FOUND', 404, 'Not available');
  }
  return loginForEmail(email);
}

// ---------- Admin management ----------

export async function listAdmins() {
  const admins = await repo.listAdmins();
  return { admins };
}

export async function createAdmin(actorId: string, input: { email: string; name: string }) {
  const existing = await repo.findAdminByEmail(input.email);
  if (existing) throw new AppError('CONFLICT', 409, 'Admin already exists');
  const admin = await repo.createAdmin(input);
  await writeAudit({
    adminId: actorId,
    action: 'admin.create',
    targetType: 'AdminUser',
    targetId: admin.id,
    after: { email: admin.email, name: admin.name },
  });
  return { admin };
}

export async function disableAdmin(actorId: string, id: string) {
  if (actorId === id) throw new AppError('BAD_REQUEST', 400, 'Cannot disable yourself');
  const admin = await repo.setAdminDisabled(id, true);
  await writeAudit({
    adminId: actorId,
    action: 'admin.disable',
    targetType: 'AdminUser',
    targetId: id,
  });
  return { admin };
}

// ---------- Academy verification ----------

export async function listAcademies(status?: AcademyStatus) {
  const academies = await repo.listAcademies(status);
  return { academies };
}

export async function getAcademy(id: string) {
  const academy = await repo.getAcademy(id);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  return { academy };
}

// Branch-review snapshot. `bankKycStatus` deliberately dropped: KYC is now a property of the
// FINANCIAL ENTITY and moves in its own queue, so recording it on a branch audit row would
// assert a fact this action did not establish.
function snapshot(a: { status: AcademyStatus; verified: boolean }) {
  return { status: a.status, verified: a.verified };
}

async function notifyAcademy(academyId: string, title: string, body: string) {
  try {
    await sendPushNotifications({ subjectId: academyId, subjectRole: 'academy', title, body });
  } catch {
    // Notification is best-effort; never fail the admin action on a push error.
  }
}

// Approve a BRANCH: address, photos, legitimacy → appearance in discovery. This is one of two
// independent queues (plan §9). It no longer touches bank KYC — that gates PAYABILITY and now
// belongs to the branch's financial entity, which several branches may share, so approving the
// fifth location must not re-run (or re-assert) the KYC the first location already passed.
// Use `verifyFinancialEntityKyc` for that.
export async function approveAcademy(actorId: string, id: string) {
  const academy = await repo.getAcademy(id);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  if (academy.status === 'approved') {
    throw new AppError('CONFLICT', 409, 'Already approved');
  }

  const before = snapshot(academy);
  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.academy.update({
      where: { id },
      data: {
        status: 'approved',
        verified: true,
        reviewReason: null,
        suspendedReason: null,
      },
    });
    await writeAudit(
      {
        adminId: actorId,
        action: 'academy.approve',
        targetType: 'Academy',
        targetId: id,
        before,
        after: snapshot(a),
      },
      tx,
    );
    return a;
  });

  await notifyAcademy(id, 'Branch approved', 'This location is now live on Findemy.');
  return { academy: await repo.getAcademy(updated.id) };
}

// Queue 2: entity KYC → PAYABILITY. Establishes RazorpayX bank KYC (Contact + FundAccount)
// from the entity's bank details. Idempotent on the KYC ids, and run once per payee no matter
// how many branches sit behind it — a branch reusing an existing entity never reaches here.
export async function verifyFinancialEntityKyc(actorId: string, entityId: string) {
  const entity = await prisma.financialEntity.findUnique({
    where: { id: entityId },
    include: { group: { select: { name: true } } },
  });
  if (!entity) throw new AppError('NOT_FOUND', 404, 'Financial entity not found');
  if (!entity.bankAccountNumber || !entity.bankIfsc || !entity.bankHolderName) {
    throw new AppError('BAD_REQUEST', 400, 'Bank details required before KYC verification');
  }

  const contactId =
    entity.rzpContactId ??
    (await rzpx.createContact({
      name: entity.label ?? entity.group.name,
      referenceId: entity.id,
    })).id;
  const fundAccountId =
    entity.rzpFundAccountId ??
    (
      await rzpx.createFundAccount({
        contactId,
        accountNumber: entity.bankAccountNumber,
        ifsc: entity.bankIfsc,
        holderName: entity.bankHolderName,
      })
    ).id;

  const updated = await prisma.$transaction(async (tx) => {
    const e = await tx.financialEntity.update({
      where: { id: entityId },
      data: {
        bankKycStatus: 'verified',
        rzpContactId: contactId,
        rzpFundAccountId: fundAccountId,
      },
    });
    await writeAudit(
      {
        adminId: actorId,
        action: 'financial_entity.kyc_verify',
        targetType: 'FinancialEntity',
        targetId: entityId,
        before: { bankKycStatus: entity.bankKycStatus },
        after: { bankKycStatus: e.bankKycStatus },
        extra: { rzpContactId: contactId, rzpFundAccountId: fundAccountId },
      },
      tx,
    );
    return e;
  });

  return { financial_entity: updated };
}

// Fail entity KYC — payouts stay frozen for every branch behind this payee, but their
// listings are untouched (that is the branch-review queue's call).
export async function failFinancialEntityKyc(actorId: string, entityId: string, reason: string) {
  const entity = await prisma.financialEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new AppError('NOT_FOUND', 404, 'Financial entity not found');
  const updated = await prisma.financialEntity.update({
    where: { id: entityId },
    data: { bankKycStatus: 'failed' },
  });
  await writeAudit({
    adminId: actorId,
    action: 'financial_entity.kyc_fail',
    targetType: 'FinancialEntity',
    targetId: entityId,
    before: { bankKycStatus: entity.bankKycStatus },
    after: { bankKycStatus: updated.bankKycStatus },
    extra: { reason },
  });
  return { financial_entity: updated };
}

export async function rejectAcademy(actorId: string, id: string, reason: string) {
  const academy = await repo.getAcademy(id);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  const before = snapshot(academy);
  await prisma.$transaction(async (tx) => {
    const a = await tx.academy.update({
      where: { id },
      data: { status: 'rejected', verified: false, reviewReason: reason },
    });
    await writeAudit(
      { adminId: actorId, action: 'academy.reject', targetType: 'Academy', targetId: id, before, after: snapshot(a), extra: { reason } },
      tx,
    );
  });
  await notifyAcademy(id, 'Application update', `Your application needs attention: ${reason}`);
  return { academy: await repo.getAcademy(id) };
}

// Suspend hides the academy from discovery (verified=false) and freezes payouts (the payout
// engine skips suspended academies). Carries a reason and notifies.
export async function suspendAcademy(actorId: string, id: string, reason: string) {
  const academy = await repo.getAcademy(id);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  const before = snapshot(academy);
  await prisma.$transaction(async (tx) => {
    const a = await tx.academy.update({
      where: { id },
      data: { status: 'suspended', verified: false, suspendedReason: reason },
    });
    await writeAudit(
      { adminId: actorId, action: 'academy.suspend', targetType: 'Academy', targetId: id, before, after: snapshot(a), extra: { reason } },
      tx,
    );
  });
  await notifyAcademy(id, 'Academy suspended', `Your academy has been suspended: ${reason}`);
  return { academy: await repo.getAcademy(id) };
}

export async function unsuspendAcademy(actorId: string, id: string) {
  const academy = await repo.getAcademy(id);
  if (!academy) throw new AppError('NOT_FOUND', 404, 'Academy not found');
  if (academy.status !== 'suspended') {
    throw new AppError('BAD_REQUEST', 400, 'Academy is not suspended');
  }
  const before = snapshot(academy);
  await prisma.$transaction(async (tx) => {
    const a = await tx.academy.update({
      where: { id },
      data: { status: 'approved', verified: true, suspendedReason: null },
    });
    await writeAudit(
      { adminId: actorId, action: 'academy.unsuspend', targetType: 'Academy', targetId: id, before, after: snapshot(a) },
      tx,
    );
  });
  await notifyAcademy(id, 'Academy reinstated', 'Your academy is live on Findemy again.');
  return { academy: await repo.getAcademy(id) };
}
