import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/app-error.js';
import * as disc from '../discontinuation/service.js';
import * as discRepo from '../discontinuation/repo.js';
import { writeAudit } from './audit.js';

// Ops Console discontinuation oversight (plan decision #8: OVERSEE + INTERVENE, no approval gate).
// The academy-initiated flow is unchanged; this is a platform-wide monitoring queue plus two
// intervention levers (refund a blocker, force-close an abandoned batch). It reuses the existing
// discontinuation service so the progress math + academy-borne recovery stay identical.

async function batchProgress(batch: { id: string; academyId: string; academy: { name: string } }) {
  // Reuse the exact per-batch computation the academy app sees (notice window, blockers, can_finish).
  const info = await disc.getBatchDiscontinuation(batch.id, batch.academyId);

  // Recovery + stuck-refund progress for this batch: recoveries/enrolment-payments are keyed to
  // this batch's enrolment periods.
  const periods = await prisma.enrollmentPeriod.findMany({
    where: { enrollment: { batchId: batch.id } },
    select: { id: true },
  });
  const periodIds = periods.map((p) => p.id);

  const recovery = await prisma.academyRecovery.aggregate({
    where: { sourceType: 'enrollment_refund', sourceId: { in: periodIds } },
    _sum: { grossPaise: true, negativePaise: true, reserveAppliedPaise: true },
  });
  const failedRefunds = await prisma.enrollmentPayment.count({
    where: { enrollmentPeriodId: { in: periodIds }, refundStatus: 'failed' },
  });

  return {
    ...info,
    academy_id: batch.academyId,
    academy_name: batch.academy.name,
    recovery_gross_paise: recovery._sum.grossPaise ?? 0,
    recovery_negative_paise: recovery._sum.negativePaise ?? 0,
    recovery_reserve_applied_paise: recovery._sum.reserveAppliedPaise ?? 0,
    failed_enrollment_refunds: failedRefunds,
  };
}

export async function listDiscontinuations() {
  const batches = await prisma.batch.findMany({
    where: { status: 'closing' },
    select: { id: true, academyId: true, academy: { select: { name: true } } },
    orderBy: { discontinueRequestedAt: 'asc' },
  });
  const discontinuations = await Promise.all(batches.map(batchProgress));
  return { discontinuations };
}

// Intervention: admin-triggered pro-rated refund of one blocking enrolment (academy bears it via
// the recovery ledger). Reuses the academy flow's refundBlockerEnrollment verbatim.
export async function refundBlocker(actorId: string, batchId: string, enrollmentId: string) {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, select: { academyId: true } });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  const result = await disc.refundBlockerEnrollment(batchId, enrollmentId, batch.academyId);
  await writeAudit({
    adminId: actorId,
    action: 'discontinuation.refund_blocker',
    targetType: 'Enrollment',
    targetId: enrollmentId,
    after: { batchId, refund_amount_paise: result.refund_amount_paise, razorpay_refund_id: result.razorpay_refund_id },
  });
  return result;
}

// Intervention: force-close an abandoned closing batch. Unlike the academy's finishDiscontinuation
// (which is gated on the 30-day notice), this refunds every remaining blocker first (academy-borne),
// then ends the batch regardless of the notice window. For staff use on abandoned batches.
export async function forceClose(actorId: string, batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { id: true, academyId: true, status: true, title: true, academy: { select: { name: true } } },
  });
  if (!batch) throw new AppError('NOT_FOUND', 404, 'Batch not found');
  if (batch.status !== 'closing') {
    throw new AppError('VALIDATION', 400, `Batch is not closing (status=${batch.status})`);
  }

  const info = await disc.getBatchDiscontinuation(batchId, batch.academyId);
  let blockersRefunded = 0;
  let totalRefundPaise = 0;
  for (const b of info.blockers) {
    const r = await disc.refundBlockerEnrollment(batchId, b.enrollment_id, batch.academyId);
    blockersRefunded++;
    totalRefundPaise += r.refund_amount_paise;
  }

  await discRepo.setBatchStatus(batchId, 'ended');
  await writeAudit({
    adminId: actorId,
    action: 'discontinuation.force_close',
    targetType: 'Batch',
    targetId: batchId,
    before: { status: 'closing', blockers: info.blockers.length, notice_days_remaining: info.notice_days_remaining },
    after: { status: 'ended', blockersRefunded, totalRefundPaise },
  });

  return { status: 'ended', blockers_refunded: blockersRefunded, total_refund_paise: totalRefundPaise };
}
