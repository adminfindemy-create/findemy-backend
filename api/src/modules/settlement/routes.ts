import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../admin/audit.js';
import * as payout from './payout.js';

const RunSchema = z.object({
  // Optional ISO date; defaults to the current in-progress week (includes today's captures).
  periodStart: z.string().datetime().optional(),
  scope: z.enum(['current', 'previous']).optional(),
});
const ListSchema = z.object({
  periodStart: z.string().datetime().optional(),
  status: z.enum(['pending', 'approved', 'processing', 'paid', 'failed', 'skipped']).optional(),
});
const IdSchema = z.object({ id: z.string().min(1) });

export const settlementRoutes: FastifyPluginAsync = async (app) => {
  // ---------- Payouts (admin) ----------
  app.get('/admin/payouts', { preHandler: app.requireAdmin('payouts.read') }, async (req) => {
    const q = ListSchema.parse(req.query);
    const payouts = await payout.listPayouts({
      periodStart: q.periodStart ? new Date(q.periodStart) : undefined,
      status: q.status,
    });
    return { payouts };
  });

  // Idempotent compute for a period. Creates `pending`/`skipped` rows only — no money moves.
  app.post('/admin/payouts/run', { preHandler: app.requireAdmin('payouts.run') }, async (req) => {
    const body = RunSchema.parse(req.body ?? {});
    const now = new Date();
    let periodStart: Date;
    let periodEnd: Date;
    if (body.periodStart) {
      periodStart = new Date(body.periodStart);
      periodEnd = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else {
      const p = body.scope === 'previous' ? payout.previousPeriod(now) : payout.currentPeriod(now);
      periodStart = p.periodStart;
      periodEnd = p.periodEnd;
    }
    const result = await payout.runPayouts(periodStart, periodEnd);
    await writeAudit({
      adminId: req.user.adminId!,
      action: 'payout.run',
      targetType: 'PayoutBatch',
      targetId: periodStart.toISOString(),
      extra: result as unknown as Record<string, unknown>,
    });
    return result;
  });

  app.post('/admin/payouts/:id/approve', { preHandler: app.requireAdmin('payouts.approve') }, async (req) => {
    const { id } = IdSchema.parse(req.params);
    const row = await payout.approvePayout(req.user.adminId!, id);
    return { payout: row };
  });

  app.post('/admin/payouts/approve-all', { preHandler: app.requireAdmin('payouts.approve') }, async (req) => {
    const body = z.object({ periodStart: z.string().datetime().optional() }).parse(req.body ?? {});
    return payout.approveAllPending(
      req.user.adminId!,
      body.periodStart ? new Date(body.periodStart) : undefined,
    );
  });

  app.post('/admin/payouts/:id/retry', { preHandler: app.requireAdmin('payouts.approve') }, async (req) => {
    const { id } = IdSchema.parse(req.params);
    const row = await payout.retryPayout(id);
    await writeAudit({
      adminId: req.user.adminId!,
      action: 'payout.retry',
      targetType: 'Payout',
      targetId: id,
    });
    return { payout: row };
  });

  // ---------- RazorpayX payout webhook (public; RazorpayX-authenticated in production) ----------
  app.post('/settlement/payouts/webhook', async (req) => {
    // RazorpayX shape: { event: 'payout.processed'|'payout.failed'|..., payload: { payout: { entity } } }.
    const body = req.body as {
      event?: string;
      payload?: { payout?: { entity?: { id?: string; utr?: string; failure_reason?: string } } };
    };
    const entity = body.payload?.payout?.entity;
    if (!body.event || !entity?.id) return { ok: false };
    const result = await payout.handlePayoutWebhook({
      event: body.event,
      transferId: entity.id,
      utr: entity.utr,
      failureReason: entity.failure_reason,
    });
    return { ok: true, ...result };
  });
};
