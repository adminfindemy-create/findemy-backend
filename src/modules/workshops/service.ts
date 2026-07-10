import crypto from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/id.js';
import { env } from '../../lib/env.js';
import * as repo from './repo.js';

// serialize only reads scalar workshop fields (never the `academy` relation),
// so its param is the base workshop shape (without `academy`). Queries that DO
// include `academy` produce a superset and remain assignable here.
function serialize(
  workshop: Awaited<ReturnType<typeof repo.findByAcademy>>[number] | null,
) {
  if (!workshop) return null;
  return {
    id: workshop.id,
    academy_id: workshop.academyId,
    type: workshop.type,
    title: workshop.title,
    description: workshop.description,
    start_at: workshop.startAt.toISOString(),
    duration_min: workshop.durationMin,
    location: workshop.location ?? undefined,
    capacity: workshop.capacity,
    registered_count: workshop.registeredCount,
    price_paise: workshop.pricePaise,
    status: workshop.status,
    live: workshop.status === 'upcoming' &&
      Date.now() >= workshop.startAt.getTime() &&
      Date.now() <= workshop.startAt.getTime() + workshop.durationMin * 60 * 1000,
    created_at: workshop.createdAt.toISOString(),
  };
}

function serializeGlobal(workshop: Awaited<ReturnType<typeof repo.findAll>>[number]) {
  return {
    ...serialize(workshop as any),
    academy_name: workshop.academy.name,
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
  const workshop = await repo.create(academyId, {
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
  return { workshop: serialize(workshop) };
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

  const workshop = await repo.update(id, {
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
  return { workshop: serialize(workshop) };
}

export async function getWorkshop(id: string) {
  const workshop = await repo.findById(id);
  if (!workshop) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  return { workshop: serializeGlobal(workshop as any) };
}

// S: academy views who booked one of its workshops. 404s if the workshop isn't theirs.
export async function getWorkshopRegistrations(academyId: string, workshopId: string) {
  const workshop = await repo.findById(workshopId);
  if (!workshop || workshop.academyId !== academyId) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  const rows = await repo.getRegistrationsForAcademy(academyId, workshopId);
  return {
    workshop: {
      id: workshop.id,
      title: workshop.title,
      capacity: workshop.capacity,
      registered_count: workshop.registeredCount,
      price_paise: workshop.pricePaise,
    },
    registrations: rows.map((registration: any) => ({
      id: registration.id,
      status: registration.status as 'pending' | 'confirmed' | 'cancelled',
      registered_at: registration.createdAt.toISOString(),
      payment_status: registration.payment?.status ?? null,
      amount_paise: registration.payment?.amountPaise ?? 0,
      user: {
        id: registration.user.id,
        name: registration.user.name,
        phone: registration.user.phone ?? null,
        age: registration.user.age ?? null,
      },
    })),
  };
}

export async function getRegistrationStatus(workshopId: string, userId: string) {
  const registration = await repo.findRegistration(workshopId, userId);
  return { registered: !!registration, status: registration?.status ?? null, registration_id: registration?.id ?? null };
}

export async function registerForWorkshop(workshopId: string, userId: string) {
  const workshop = await repo.findById(workshopId);
  if (!workshop) throw new AppError('NOT_FOUND', 404, 'Workshop not found');
  if (workshop.status !== 'upcoming') throw new AppError('VALIDATION', 400, 'Workshop is not open for registration');
  if (workshop.registeredCount >= workshop.capacity) throw new AppError('VALIDATION', 400, 'Workshop is full');

  const existingRegistration = await repo.findRegistration(workshopId, userId);
  if (existingRegistration) {
    if (existingRegistration.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already registered');
    // Pending (awaiting payment) — return registration to let them pay
    if (existingRegistration.status === 'pending' && workshop.pricePaise > 0) {
      return { registration_id: existingRegistration.id, requires_payment: true, amount_paise: workshop.pricePaise };
    }
  }

  const registration = existingRegistration ?? await repo.createRegistration(workshopId, userId);

  // Free workshop — confirm immediately
  if (workshop.pricePaise === 0) {
    await repo.confirmRegistration(registration.id);
    await repo.incrementRegisteredCount(workshopId);
    return { registration_id: registration.id, requires_payment: false, amount_paise: 0 };
  }

  return { registration_id: registration.id, requires_payment: true, amount_paise: workshop.pricePaise };
}

// Lazily constructed & cached — avoids paying the `import('razorpay')` cost on every
// request, and avoids constructing a client with empty keys when running mocked/unconfigured.
let razorpayInstance: any;
async function getRazorpay() {
  if (razorpayInstance) return razorpayInstance;
  const { default: Razorpay } = await import('razorpay');
  razorpayInstance = new Razorpay({ key_id: env.RAZORPAY_KEY_ID || '', key_secret: env.RAZORPAY_KEY_SECRET || '' });
  return razorpayInstance;
}

export async function createWorkshopPaymentOrder(registrationId: string, userId: string) {
  const registration = await (await import('../../lib/prisma.js')).prisma.workshopRegistration.findUnique({
    where: { id: registrationId },
    include: { workshop: true },
  }) as any;
  if (!registration) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (registration.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (registration.status === 'confirmed') throw new AppError('VALIDATION', 400, 'Already confirmed');

  const amountPaise = registration.workshop.pricePaise;
  const idempotencyKey = crypto.createHash('sha256').update(`ws:${registrationId}:${amountPaise}`).digest('hex');

  const existingPayment = await (await import('../../lib/prisma.js')).prisma.workshopPayment.findUnique({
    where: { idempotencyKey },
  }) as any;
  if (existingPayment) {
    return { razorpay_order_id: existingPayment.razorpayOrderId, razorpay_key: env.RAZORPAY_KEY_ID || 'rzp_test_xxx', amount_paise: existingPayment.amountPaise, currency: existingPayment.currency };
  }

  let razorpayOrderId = `order_ws_${newId().slice(0, 12)}`;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const razorpayClient = await getRazorpay();
    const order = await razorpayClient.orders.create({
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
  const registration = await repo.findRegistrationById(registrationId);
  if (!registration) throw new AppError('NOT_FOUND', 404, 'Registration not found');
  if (registration.userId !== userId) throw new AppError('FORBIDDEN', 403, 'Not your registration');
  if (registration.status === 'cancelled') throw new AppError('VALIDATION', 400, 'Already cancelled');
  if (registration.status !== 'confirmed') throw new AppError('VALIDATION', 400, 'Registration not confirmed');

  // S4.4: workshops are NON-REFUNDABLE, full stop — no refund window, no acknowledgement gate.
  await db.$transaction(async (tx: any) => {
    await repo.cancelRegistration(registrationId, tx);
    await repo.decrementRegisteredCount(registration.workshopId, tx);
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
