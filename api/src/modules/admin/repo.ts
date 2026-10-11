import type { AcademyStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { signKycEntity } from '../../lib/kyc-files.js';

// ---------- Admin allowlist ----------

export function findAdminByEmail(email: string) {
  return prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
}

export function findAdminById(id: string) {
  return prisma.adminUser.findUnique({ where: { id } });
}

export function listAdmins() {
  return prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } });
}

export function createAdmin(data: { email: string; name: string }) {
  return prisma.adminUser.create({
    data: { email: data.email.toLowerCase(), name: data.name },
  });
}

export function setAdminDisabled(id: string, disabled: boolean) {
  return prisma.adminUser.update({ where: { id }, data: { disabled } });
}

// ---------- Refresh tokens (admin sessions reuse the shared table) ----------

export function createRefreshToken(data: {
  id: string;
  subjectId: string;
  tokenHash: string;
  expiresAt: Date;
}) {
  return prisma.refreshToken.create({
    data: { ...data, subjectRole: 'admin' },
  });
}

// ---------- Academy verification ----------

// A BRANCH row for the ops console. Identity and review state are the branch's own; every
// KYC/bank field is read THROUGH the financial entity, because a payee can back several
// branches and rendering its KYC as if it belonged to one location is exactly the conflation
// the two-queue split exists to undo (plan §9). Note `gstRegistrations` is a LIST — one entity
// operating in two states holds two GSTINs.
const ACADEMY_LIST_SELECT = {
  id: true,
  name: true,
  branchLabel: true,
  category: true,
  address: true,
  status: true,
  verified: true,
  reviewReason: true,
  suspendedReason: true,
  rating: true,
  ratingCount: true,
  createdAt: true,
  group: { select: { id: true, name: true } },
  financialEntity: {
    select: {
      id: true,
      label: true,
      bankKycStatus: true,
      rzpContactId: true,
      rzpFundAccountId: true,
      bankAccountNumber: true,
      bankIfsc: true,
      bankHolderName: true,
      panNumber: true,
      panImageUrl: true,
      aadhaarLast4: true,
      aadhaarImageUrl: true,
      businessDocUrls: true,
      gstRegistrations: { select: { id: true, gstNumber: true, state: true } },
      _count: { select: { branches: true } },
    },
  },
} satisfies Prisma.AcademySelect;

// The entity-KYC queue: one row per payee, with the branches it backs. A brand-new branch
// reusing an existing entity never appears here — that is the whole point of the split.
export async function listFinancialEntities(bankKycStatus?: 'unverified' | 'verified' | 'failed') {
  const entities = await prisma.financialEntity.findMany({
    where: bankKycStatus ? { bankKycStatus } : undefined,
    include: {
      group: { select: { id: true, name: true } },
      gstRegistrations: { select: { id: true, gstNumber: true, state: true } },
      branches: { select: { id: true, name: true, branchLabel: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(entities.map(signKycEntity));
}

// KYC document keys in the academy rows below are swapped for short-lived presigned URLs.
type AcademyListRow = Prisma.AcademyGetPayload<{ select: typeof ACADEMY_LIST_SELECT }>;
async function signAcademy(a: AcademyListRow): Promise<AcademyListRow> {
  return a.financialEntity ? { ...a, financialEntity: await signKycEntity(a.financialEntity) } : a;
}

export async function listAcademies(status?: AcademyStatus) {
  const rows = await prisma.academy.findMany({
    where: status ? { status } : undefined,
    select: ACADEMY_LIST_SELECT,
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(rows.map(signAcademy));
}

export async function getAcademy(id: string) {
  const row = await prisma.academy.findUnique({ where: { id }, select: ACADEMY_LIST_SELECT });
  return row ? signAcademy(row) : null;
}

export async function updateAcademy(id: string, data: Prisma.AcademyUpdateInput) {
  return signAcademy(await prisma.academy.update({ where: { id }, data, select: ACADEMY_LIST_SELECT }));
}
