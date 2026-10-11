/**
 * Seed dummy data for testing cancel workflows.
 *
 * Creates for user Varun (01KSG2YMYV5CM6TVMWH5WPC59J):
 *  - 2 trial bookings (one cancellable, one inside the 4h window)
 *  - 2 workshop registrations (one cancellable, one inside the 24h window)
 *
 * Run:  node scripts/seed-cancel-data.js
 */

const { PrismaClient } = require('@prisma/client');
const crypto = require('node:crypto');

const prisma = new PrismaClient();

const USER_ID = '01KSG2YMYV5CM6TVMWH5WPC59J';
const BATCH_ID = '01KSB3TEEQ8YEHEMZ04HDV12MR'; // Guitar · Beginner
const ACADEMY_ID = '01KSB3TEENKK8HDKHHTDF1KEX2';
const EXISTING_WORKSHOP_ID = 'cmplgkydd0005t42p13r74qwm'; // 2026-07-09, >24h away

const HOUR = 60 * 60 * 1000;
const now = Date.now();

function rid(prefix = '') {
  return prefix + crypto.randomBytes(10).toString('hex');
}

async function createTrialBooking({ slotTime, label }) {
  const slot = await prisma.slot.create({
    data: {
      batchId: BATCH_ID,
      slotTime,
      capacity: 10,
      reservedCount: 1,
      status: 'open',
    },
  });

  const booking = await prisma.booking.create({
    data: {
      userId: USER_ID,
      batchId: BATCH_ID,
      slotId: slot.id,
      status: 'confirmed',
      reservationExpiresAt: new Date(now - HOUR),
      paidAt: new Date(now - HOUR),
    },
  });

  await prisma.payment.create({
    data: {
      bookingId: booking.id,
      amountPaise: 9900,
      currency: 'INR',
      razorpayOrderId: rid('order_seed_'),
      razorpayPaymentId: rid('pay_seed_'),
      status: 'captured',
      idempotencyKey: rid('idem_seed_'),
      capturedAt: new Date(now - HOUR),
    },
  });

  const trial = await prisma.trial.create({
    data: {
      userId: USER_ID,
      academyId: ACADEMY_ID,
      batchId: BATCH_ID,
      slotId: slot.id,
      bookingId: booking.id,
      trialAt: slotTime,
      status: 'booked',
    },
  });

  console.log(`  [${label}] trial=${trial.id} booking=${booking.id} slotTime=${slotTime.toISOString()}`);
  return { trial, booking, slot };
}

async function createWorkshopRegistration({ workshopId, label }) {
  // Check if registration already exists (workshopId+userId unique)
  const existing = await prisma.workshopRegistration.findUnique({
    where: { workshopId_userId: { workshopId, userId: USER_ID } },
  });
  if (existing) {
    console.log(`  [${label}] registration already exists (id=${existing.id}, status=${existing.status}) — skipping`);
    return existing;
  }

  const reg = await prisma.workshopRegistration.create({
    data: {
      workshopId,
      userId: USER_ID,
      status: 'confirmed',
    },
  });

  await prisma.workshopPayment.create({
    data: {
      registrationId: reg.id,
      amountPaise: 10000,
      currency: 'INR',
      razorpayOrderId: rid('order_ws_seed_'),
      razorpayPaymentId: rid('pay_ws_seed_'),
      status: 'captured',
      idempotencyKey: rid('idem_ws_seed_'),
      capturedAt: new Date(now - HOUR),
    },
  });

  await prisma.workshop.update({
    where: { id: workshopId },
    data: { registeredCount: { increment: 1 } },
  });

  console.log(`  [${label}] registration=${reg.id} workshop=${workshopId}`);
  return reg;
}

async function main() {
  console.log('Seeding cancel-flow test data for user', USER_ID, '\n');

  console.log('Trials:');
  await createTrialBooking({
    slotTime: new Date(now + 48 * HOUR),
    label: 'CANCELLABLE (slot 2 days away)',
  });
  await createTrialBooking({
    slotTime: new Date(now + 2 * HOUR),
    label: 'WINDOW CLOSED (slot 2h away, < 4h cutoff)',
  });

  console.log('\nWorkshops:');
  // Cancellable: existing workshop on 2026-07-09 (>24h away)
  await createWorkshopRegistration({
    workshopId: EXISTING_WORKSHOP_ID,
    label: 'CANCELLABLE (workshop 2026-07-09)',
  });

  // Window-closed: create a new workshop 5h from now
  const lateWorkshop = await prisma.workshop.create({
    data: {
      academyId: ACADEMY_ID,
      type: 'offline',
      title: '[TEST] Late-window workshop',
      description: 'For testing the 24h cancel cutoff. Starts in 5 hours.',
      startAt: new Date(now + 5 * HOUR),
      durationMin: 60,
      location: 'Test Studio',
      capacity: 20,
      pricePaise: 10000,
      status: 'upcoming',
    },
  });
  await createWorkshopRegistration({
    workshopId: lateWorkshop.id,
    label: `WINDOW CLOSED (workshop ${lateWorkshop.id} starts in 5h)`,
  });

  console.log('\nDone. Open the student app:');
  console.log('  - Trials tab     → 2 booked trials (cancel one, the other will show 4h-window error)');
  console.log('  - Workshops tab  → 2 booked workshops (cancel guitar one; the late one hides the cancel link)');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
