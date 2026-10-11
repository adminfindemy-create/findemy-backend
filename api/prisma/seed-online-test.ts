/**
 * seed-online-test.ts
 * Creates a complete online class test scenario:
 *   - Online batch (mode=online) under an existing academy
 *   - Enrollment for the first student user found
 *   - A slot starting 5 minutes ago (inside the join window)
 *
 * Run: npx tsx prisma/seed-online-test.ts
 */

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulidx';

const prisma = new PrismaClient();

async function main() {
  // ── 1. Find an existing academy ──────────────────────────────────────────
  const academy = await prisma.academy.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!academy) {
    console.error('No academy found. Run the main seed first: npx prisma db seed');
    process.exit(1);
  }
  console.log(`Using academy: ${academy.name} (${academy.id})`);

  // ── 2. Find or create a coach for that academy ───────────────────────────
  let coach = await prisma.coach.findFirst({ where: { academyId: academy.id } });
  if (!coach) {
    coach = await prisma.coach.create({
      data: {
        id: ulid(),
        academyId: academy.id,
        name: 'Demo Coach',
        specialty: 'Online Classes',
      },
    });
    console.log(`Created coach: ${coach.name}`);
  } else {
    console.log(`Using coach: ${coach.name} (${coach.id})`);
  }

  // ── 3. Find a student user ───────────────────────────────────────────────
  const student = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!student) {
    console.error('No student user found. Register a student in the app first.');
    process.exit(1);
  }
  console.log(`Using student: ${student.name ?? student.phone} (${student.id})`);

  // ── 4. Create (or reuse) an online batch ─────────────────────────────────
  const BATCH_TITLE = '[TEST] Online Live Class';
  let batch = await prisma.batch.findFirst({
    where: { academyId: academy.id, title: BATCH_TITLE },
  });

  if (!batch) {
    // Every batch lives under a program — find or create one for this test offering.
    let program = await prisma.program.findFirst({
      where: { academyId: academy.id, title: BATCH_TITLE },
    });
    if (!program) {
      program = await prisma.program.create({
        data: {
          id: ulid(),
          academyId: academy.id,
          title: BATCH_TITLE,
          category: academy.category,
          description: 'Test online live-class program.',
        },
      });
    }
    batch = await prisma.batch.create({
      data: {
        id: ulid(),
        academyId: academy.id,
        programId: program.id,
        coachId: coach.id,
        title: BATCH_TITLE,
        category: academy.category,
        level: 'Beginner',
        description: 'Test online live-class program.',
        capacity: 10,
        trialFeePaise: 9900,
        monthlyFeePaise: 149900,
        mode: 'online',
      },
    });

    // Add timings for today's day of week so it shows in the schedule
    const todayDow = new Date().getDay();
    await prisma.batchTiming.create({
      data: {
        id: ulid(),
        batchId: batch.id,
        dayOfWeek: todayDow,
        startTime: '10:00',
        durationMin: 60,
      },
    });

    console.log(`Created online batch: ${batch.title} (${batch.id})`);
  } else {
    console.log(`Reusing existing batch: ${batch.title} (${batch.id})`);
  }

  // ── 5. Enroll the student if not already enrolled ────────────────────────
  const existing = await prisma.enrollment.findFirst({
    where: { batchId: batch.id, userId: student.id },
  });

  if (!existing) {
    await prisma.enrollment.create({
      data: {
        id: ulid(),
        batchId: batch.id,
        userId: student.id,
        status: 'active',
        startedAt: new Date(),
      },
    });
    console.log(`Enrolled student in batch`);
  } else {
    // Make sure enrollment is active
    if (existing.status !== 'active') {
      await prisma.enrollment.update({
        where: { id: existing.id },
        data: { status: 'active' },
      });
    }
    console.log(`Student already enrolled (status: ${existing.status})`);
  }

  // ── 6. Create a slot starting 5 min ago (inside join window) ─────────────
  const slotTime = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago

  const existingSlot = await prisma.slot.findFirst({
    where: {
      batchId: batch.id,
      slotTime: { gte: new Date(Date.now() - 15 * 60 * 1000) },
    },
  });

  if (!existingSlot) {
    await prisma.slot.create({
      data: {
        id: ulid(),
        batchId: batch.id,
        slotTime,
        capacity: 10,
        reservedCount: 0,
        status: 'open',
      },
    });
    console.log(`Created live slot at ${slotTime.toISOString()}`);
  } else {
    console.log(`Live slot already exists: ${existingSlot.slotTime.toISOString()}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n✓ Test data ready. In the student app:');
  console.log(`  1. Go to academy "${academy.name}"`);
  console.log(`  2. Tap "Explore Programs & Workshops"`);
  console.log(`  3. You should see "[TEST] Online Live Class" with an Online badge`);
  console.log(`  4. Your Classes → should show this batch with "● Live" pill`);
  console.log(`  5. Tap the card → "Join Class →" button should appear`);
  console.log(`  6. Tap → /live screen loads with mock token\n`);
  console.log(`  Academy ID: ${academy.id}`);
  console.log(`  Batch ID:   ${batch.id}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
