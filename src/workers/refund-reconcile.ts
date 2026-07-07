import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';

let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  return razorpayInstance;
}

type PaymentTable = 'payment' | 'workshopPayment' | 'eventPayment' | 'enrollmentPayment';

async function reconcileTable(table: PaymentTable, rp: any) {
  let updated = 0;

  const stale = await (prisma as any)[table].findMany({
    where: { refundStatus: 'requested' },
    select: { id: true, razorpayRefundId: true, razorpayPaymentId: true },
  });

  for (const rec of stale) {
    if (!rec.razorpayRefundId || !rec.razorpayPaymentId) continue;
    try {
      const refund = await rp.payments.fetchRefund(rec.razorpayPaymentId, rec.razorpayRefundId);
      if (refund.status === 'processed') {
        await (prisma as any)[table].update({ where: { id: rec.id }, data: { refundStatus: 'processed', refundedAt: new Date() } });
        updated++;
      } else if (refund.status === 'failed') {
        await (prisma as any)[table].update({ where: { id: rec.id }, data: { refundStatus: 'failed' } });
        updated++;
      }
    } catch { /* skip; will retry next run */ }
  }

  return updated;
}

export async function reconcileStaleRefunds() {
  const rp = await getRazorpay();
  if (!rp) return { updated: 0, skipped: 'no_razorpay_config' };

  const tables: PaymentTable[] = ['payment', 'workshopPayment', 'eventPayment', 'enrollmentPayment'];
  let total = 0;
  for (const table of tables) {
    total += await reconcileTable(table, rp);
  }
  return { updated: total };
}
