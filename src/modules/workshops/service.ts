import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import * as repo from './repo.js';

// serialize only reads scalar workshop fields (never the `academy` relation),
// so its param is the base workshop shape (without `academy`). Queries that DO
// include `academy` produce a superset and remain assignable here.
function serialize(
  w: Awaited<ReturnType<typeof repo.findByAcademy>>[number] | null,
) {
  if (!w) return null;
  return {
    id: w.id,
    academy_id: w.academyId,
    type: w.type,
    title: w.title,
    description: w.description,
    start_at: w.startAt.toISOString(),
    duration_min: w.durationMin,
    location: w.location ?? undefined,
    capacity: w.capacity,
    registered_count: w.registeredCount,
    price_paise: w.pricePaise,
    status: w.status,
    live: w.status === 'upcoming' &&
      Date.now() >= w.startAt.getTime() &&
      Date.now() <= w.startAt.getTime() + w.durationMin * 60 * 1000,
    created_at: w.createdAt.toISOString(),
  };
}

function serializeGlobal(w: Awaited<ReturnType<typeof repo.findAll>>[number]) {
  return {
    ...serialize(w as any),
    academy_name: w.academy.name,
  };
}

export async function listAll() {
  const workshops = await repo.findAll();
  return { items: workshops.map(serializeGlobal) };
}

export async function listForAcademy(academyId: string) {
  const workshops = await repo.findByAcademy(academyId);
  return { items: workshops.map(serialize) };
}

export async function listForStudio(academyId: string) {
  const workshops = await repo.findByStudio(academyId);
  return { items: workshops.map(serialize) };
}

export async function createWorkshop(academyId: string, body: {
  type: 'online' | 'offline';
  title: string;
  description: string;
  start_at: string;
  duration_min: number;
  location?: string;
  capacity: number;
  price_paise: number;
  status?: 'draft' | 'upcoming';
}) {
  const w = await repo.create(academyId, {
    type: body.type,
    title: body.title,
    description: body.description,
    startAt: new Date(body.start_at),
    durationMin: body.duration_min,
    location: body.location,
    capacity: body.capacity,
    pricePaise: body.price_paise,
    status: body.status ?? 'upcoming',
  });
  return { workshop: serialize(w) };
}

export async function updateWorkshop(id: string, academyId: string, body: Partial<{
  type: 'online' | 'offline';
  title: string;
  description: string;
  start_at: string;
  duration_min: number;
  location?: string;
  capacity: number;
  price_paise: number;
  status?: 'draft' | 'upcoming';
}>) {
  const existing = await repo.findById(id);
  if (!existing) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (existing.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your workshop');

  const w = await repo.update(id, {
    type: body.type,
    title: body.title,
    description: body.description,
    startAt: body.start_at ? new Date(body.start_at) : undefined,
    durationMin: body.duration_min,
    location: body.location,
    capacity: body.capacity,
    pricePaise: body.price_paise,
    status: body.status,
  });
  return { workshop: serialize(w) };
}

export async function getWorkshop(id: string) {
  const w = await repo.findById(id);
  if (!w) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  return { workshop: serializeGlobal(w as any) };
}

// S: academy views who booked one of its workshops. 404s if the workshop isn't theirs.
export async function getWorkshopRegistrations(academyId: string, workshopId: string) {
  const w = await repo.findById(workshopId);
  if (!w || w.academyId !== academyId) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  const rows = await repo.getRegistrationsForAcademy(academyId, workshopId);
  return {
    workshop: {
      id: w.id,
      title: w.title,
      capacity: w.capacity,
      registered_count: w.registeredCount,
      price_paise: w.pricePaise,
    },
    registrations: rows.map((r: any) => ({
      id: r.id,
      status: r.status as 'pending' | 'confirmed' | 'cancelled',
      registered_at: r.createdAt.toISOString(),
      payment_status: r.payment?.status ?? null,
      amount_paise: r.payment?.amountPaise ?? 0,
      user: {
        id: r.user.id,
        name: r.user.name,
        phone: r.user.phone ?? null,
        age: r.user.age ?? null,
      },
    })),
  };
}

export async function getRegistrationStatus(workshopId: string, userId: string) {
  const reg = await repo.findRegistration(workshopId, userId);
  return { registered: !!reg, status: reg?.status ?? null, registration_id: reg?.id ?? null };
}

export async function registerForWorkshop(workshopId: string, userId: string) {
  const w = await repo.findById(workshopId);
  if (!w) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (w.status !== 'upcoming') throw new AppError('VALIDATION', 400, 'Workshop is not open for registration');
  if (w.registeredCount >= w.capacity) throw new AppError('VALIDATION', 400, 'Workshop is full');

  const existing = await repo.findRegistration(workshopId, userId);
  if (existing) {
    if (existing.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already registered');
    // Pending (awaiting payment) — return registration to let them pay
    if (existing.status === 'pending' && w.pricePaise > 0) {
      return { registration_id: existing.id, requires_payment: true, amount_paise: w.pricePaise };
    }
  }

  const reg = existing ?? await repo.createRegistration(workshopId, userId);

  // Free workshop — confirm immediately
  if (w.pricePaise === 0) {
    await repo.confirmRegistration(reg.id);
    await repo.incrementRegisteredCount(workshopId);
    return { registration_id: reg.id, requires_payment: false, amount_paise: 0 };
  }

  return { registration_id: reg.id, requires_payment: true, amount_paise: w.pricePaise };
}

let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID || '', key_secret: env.RAZORPAY_KEY_SECRET || '' });
  return razorpayInstance;
}

export async function createWorkshopPaymentOrder(registrationId: string, userId: string) {
  const reg = await (await import('../../lib/prisma.js')).prisma.workshopRegistration.findUnique({
    where: { id: registrationId },
    include: { workshop: true },
  }) as any;
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (reg.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already confirmed');

  const amountPaise = reg.workshop.pricePaise;
  const idempotencyKey = crypto.createHash('sha256').update(`ws:${registrationId}:${amountPaise}`).digest('hex');

  const existing = await (await import('../../lib/prisma.js')).prisma.workshopPayment.findUnique({
    where: { idempotencyKey },
  }) as any;
  if (existing) {
    return { razorpay_order_id: existing.razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: existing.amountPaise, currency: existing.currency };
  }

  let razorpayOrderId = `order_ws_${newId().slice(0, 12)}`;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const rp = await getRazorpay();
    const order = await rp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: registrationId,
      notes: { workshop_registration_id: registrationId },
    });
    razorpayOrderId = order.id;
  }

  await repo.createWorkshopPayment({ id: newId(), registrationId, amountPaise, currency: 'INR', razorpayOrderId, idempotencyKey });

  return { razorpay_order_id: razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: amountPaise, currency: 'INR' };
}

export async function cancelWorkshopRegistration(
  registrationId: string,
  userId: string,
  _opts: { acknowledgeNoRefund?: boolean; reason?: string } = {},
) {
  const { prisma: db } = await import('../../lib/prisma.js');
  const reg = await repo.findRegistrationById(registrationId);
  if (!reg) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (reg.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (reg.status === 'cancelled') throw new AppError('VALIDATION', 400, 'Already cancelled');
  if (reg.status !== 'confirmed') throw new AppError('VALIDATION', 400, 'Registration not confirmed');

  // S4.4: workshops are NON-REFUNDABLE, full stop — no refund window, no acknowledgement gate.
  await db.$transaction(async (tx: any) => {
    await repo.cancelRegistration(registrationId, tx);
    await repo.decrementRegisteredCount(reg.workshopId, tx);
  });

  return {
    cancelled: true,
    refund_eligible: false,
    refund_initiated: false,
    refund_amount_paise: 0,
  };
}

export async function deleteWorkshop(id: string, academyId: string) {
  const existing = await repo.findById(id);
  if (!existing) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (existing.academyId !== academyId) throw new AppError('FORBIDDEN', 403, 'Not your workshop');
  await repo.remove(id);
  return {};
}
