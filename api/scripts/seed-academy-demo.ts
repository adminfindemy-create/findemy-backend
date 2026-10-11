/**
 * Demo data for ONE academy, so every academy-app screen has something to show.
 *
 *   pnpm --filter @findemy/api seed:academy            # defaults to 8826165674 (VD Academy)
 *   ACADEMY_PHONE=9876500010 pnpm --filter @findemy/api seed:academy
 *
 * Scoped and repeatable: it deletes only the rows belonging to THIS academy (and the demo
 * students it created, identified by the 9111xxxxxx phone block) before re-creating them, so
 * other academies and the main `pnpm seed` data are never touched. Run it as often as you like.
 *
 * What it lays down: address + coordinates so the academy is discoverable, 3 coaches,
 * 3 programs with media, 5 batches covering every attribute combination (weekday/weekend,
 * online, one-on-one, women-only, an age-bracketed kids batch), 8 students with enrolments
 * (active, paused, ended, left mid-period), upcoming and past trials, recorded class sessions
 * covering all four states (held/full, held/partial, cancelled, not-recorded) with explicit
 * absences shaped to produce all three attendance tiers, reviews, class notes, and the payment +
 * commission rows the Earnings screen reads.
 */
import {
  PrismaClient,
  Category,
  AcademyStatus,
  BatchMode,
  BatchStatus,
  SessionFormat,
  BatchGender,
  BookingStatus,
  TrialStatus,
  EnrollmentStatus,
  EnrollmentPackage,
  EnrollmentPeriodStatus,
  PauseDuration,
  PauseStatus,
  PaymentStatus,
  CommissionItemType,
  CommissionStatus,
  StaffStatus,
} from '@prisma/client';

import { selfLearnerCreate } from '../src/lib/learner-access.js';

const prisma = new PrismaClient();

/** A demo student's own learner — every row about attending is keyed on it. */
async function learnerOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { selfLearnerId: true } });
  return u.selfLearnerId!;
}

const ACADEMY_PHONE = process.env.ACADEMY_PHONE ?? '8826165674';
/** Demo students live in this phone block so they can be cleaned up without guessing. */
const DEMO_PHONE_PREFIX = '9111';
const COMMISSION_BPS = 1500;

// ---------- date helpers (IST wall clock is close enough for demo data) ----------

const DAY = 24 * 60 * 60 * 1000;

/** Midnight-anchored date `n` days from today (negative = past). */
function dayOffset(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + n * DAY);
}

function at(n: number, hour: number, minute = 0): Date {
  const d = dayOffset(n);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/**
 * `@db.Date` columns want UTC midnight of the SAME calendar day.
 * Do NOT round-trip through toISOString(): these dates are local (IST) midnights, and
 * IST midnight is the previous day in UTC, which silently shifted every seeded date back
 * one day — putting Mon/Wed/Fri class notes on Sunday and Tuesday.
 */
function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/** The most recent `count` dates (newest first) that fall on one of `dows`, excluding today. */
function pastOccurrences(dows: number[], count: number): Date[] {
  const out: Date[] = [];
  for (let i = 1; out.length < count && i < 120; i++) {
    const d = dayOffset(-i);
    if (dows.includes(d.getDay())) out.push(d);
  }
  return out;
}

function nextOccurrence(dow: number, hour: number, minute = 0): Date {
  for (let i = 1; i < 14; i++) {
    const d = dayOffset(i);
    if (d.getDay() === dow) {
      d.setHours(hour, minute, 0, 0);
      return d;
    }
  }
  return at(3, hour, minute);
}

const rupees = (n: number) => n * 100;

// ---------- content ----------

const COACHES = [
  { name: 'Varun Dara', specialty: 'Guitar & Songwriting', bio: 'Ten years of teaching, from first chord to stage-ready.' },
  { name: 'Ritika Sen', specialty: 'Keyboard & Theory', bio: 'Trinity-certified; loves getting beginners reading music fast.' },
  { name: 'Imran Qureshi', specialty: 'Vocals', bio: 'Hindustani foundation, contemporary repertoire.' },
];

const IMG = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&h=600&q=80&auto=format&fit=crop`;
const MEDIA = {
  guitar: ['1511379938547-c1f69419868d', '1510915361894-db8b60106cb1', '1493225457124-a3eb161ffa5f'],
  keys: ['1520523839897-bd0b52f945a0', '1552422535-c45813c61732', '1571974599782-87624638275e'],
  vocals: ['1516280440614-37939bbacd81', '1493676304819-0d7a8d026dcf', '1499415479124-43c32433a620'],
};

const STUDENTS = [
  { name: 'Aarav Malhotra', age: 24 },
  { name: 'Diya Krishnan', age: 19 },
  { name: 'Kabir Sethi', age: 31 },
  { name: 'Meher Gill', age: 27 },
  { name: 'Rohan Iyer', age: 22 },
  { name: 'Sanya Bhatt', age: 16 },
  { name: 'Tanvi Rao', age: 29 },
  { name: 'Yash Pandey', age: 35 },
];

async function main() {
  // A login belongs to a BRAND that owns branches. This demo seeds the account's landing
  // branch — its default, else the group's first — and authors coaches/programs on the group.
  const account = await prisma.academyAccount.findUnique({
    where: { phone: ACADEMY_PHONE },
    include: {
      group: { include: { branches: { orderBy: { createdAt: 'asc' } } } },
      defaultAcademy: true,
    },
  });
  const branch = account?.defaultAcademy ?? account?.group?.branches[0] ?? null;
  if (!account?.group || !branch) {
    throw new Error(
      `No academy linked to ${ACADEMY_PHONE}. Log into the academy app with that number and finish onboarding first.`,
    );
  }
  const groupId = account.group.id;
  const academyId = branch.id;
  // Commission is reported per branch but settled per payee, so both are written together.
  const financialEntityId = branch.financialEntityId;
  console.log(`▸ seeding "${account.group.name}" — ${branch.branchLabel ?? branch.name} (${ACADEMY_PHONE})`);

  await wipe(academyId);

  // ---------- the academy itself ----------
  await prisma.academy.update({
    where: { id: academyId },
    data: {
      status: AcademyStatus.approved,
      category: Category.music,
      tagline: 'Learn an instrument the way musicians actually learn one.',
      bio: 'A small music school in Saket — guitar, keys and voice, taught in batches of eight or fewer.',
      address: 'Saket, New Delhi',
      lat: 28.5245,
      lng: 77.2066,
      specialities: ['Guitar', 'Keyboard', 'Vocals'],
      images: [IMG(MEDIA.guitar[0]), IMG(MEDIA.keys[0])],
      modesOffered: ['in_studio', 'online'],
    },
  });

  // ---------- coaches ----------
  const coaches = [];
  for (const c of COACHES) {
    // Brand-level: one coach row, teaching wherever their batches run.
    coaches.push(await prisma.coach.create({ data: { groupId, homeBranchId: academyId, ...c } }));
  }

  // ---------- people (staff) ----------
  // The People screen lists StaffAccounts, not coaches — a coach with no account shows up
  // nowhere. Each coach here gets a teacher account scoped to this branch, plus a manager and
  // a deactivated ex-teacher so all three status states the screen renders have an example.
  const roles = await prisma.staffRole.findMany({ where: { isSystem: true } });
  const roleId = (key: string) => roles.find((r) => r.key === key)!.id;

  const staffPlan: { name: string; phone: string; role: string; coachIdx?: number; status: StaffStatus }[] = [
    { name: COACHES[0].name, phone: `${DEMO_PHONE_PREFIX}200001`, role: 'teacher', coachIdx: 0, status: StaffStatus.active },
    { name: COACHES[1].name, phone: `${DEMO_PHONE_PREFIX}200002`, role: 'teacher', coachIdx: 1, status: StaffStatus.active },
    // Invited: the phone IS the invite, so this one simply has not signed in yet.
    { name: COACHES[2].name, phone: `${DEMO_PHONE_PREFIX}200003`, role: 'teacher', coachIdx: 2, status: StaffStatus.invited },
    { name: 'Priya Nair', phone: `${DEMO_PHONE_PREFIX}200004`, role: 'manager', status: StaffStatus.active },
    { name: 'Sameer Khanna', phone: `${DEMO_PHONE_PREFIX}200005`, role: 'teacher', status: StaffStatus.deactivated },
  ];

  for (const sp of staffPlan) {
    const staff = await prisma.staffAccount.create({
      data: {
        groupId,
        name: sp.name,
        phone: sp.phone,
        status: sp.status,
        activatedAt: sp.status === StaffStatus.active ? new Date() : null,
        deactivatedAt: sp.status === StaffStatus.deactivated ? new Date() : null,
      },
    });
    const assignment = await prisma.staffRoleAssignment.create({
      data: {
        staffId: staff.id,
        roleId: roleId(sp.role),
        coachId: sp.coachIdx !== undefined ? coaches[sp.coachIdx].id : null,
      },
    });
    await prisma.staffBranchScope.create({ data: { assignmentId: assignment.id, academyId } });
  }

  // ---------- programs ----------
  async function program(title: string, level: string, description: string, media: string[]) {
    const p = await prisma.program.create({
      data: {
        // Brand-level: authored once. Which branches offer it is derived from its batches.
        groupId,
        title,
        category: Category.music,
        level,
        description,
        thingsToKnow: ['Bring your own instrument if you have one', 'Arrive 10 minutes early'],
      },
    });
    await prisma.programMedia.createMany({
      data: media.map((id, i) => ({ programId: p.id, url: IMG(id), type: 'photo', order: i })),
    });
    return p;
  }

  const guitar = await program('Guitar', 'Beginner', 'Chords, strumming and your first five songs.', MEDIA.guitar);
  const keys = await program('Keyboard', 'Beginner', 'Both hands, basic theory and reading from a score.', MEDIA.keys);
  const vocals = await program('Vocals', 'Intermediate', 'Breath, pitch and performing without straining.', MEDIA.vocals);

  // ---------- batches (every attribute combination worth testing) ----------
  type Spec = {
    program: { id: string; title: string };
    name: string;
    coach: string;
    dows: number[];
    time: string;
    duration: number;
    capacity: number;
    trial: number;
    monthly: number;
    mode?: BatchMode;
    format?: SessionFormat;
    gender?: BatchGender;
    minAge?: number | null;
    maxAge?: number | null;
  };

  const specs: Spec[] = [
    { program: guitar, name: 'Weekday Evening', coach: coaches[0].id, dows: [1, 3, 5], time: '18:00', duration: 60, capacity: 8, trial: 200, monthly: 3200 },
    { program: guitar, name: 'Kids Weekend', coach: coaches[0].id, dows: [6, 0], time: '10:00', duration: 90, capacity: 10, trial: 150, monthly: 2800, minAge: 8, maxAge: 14 },
    { program: guitar, name: 'One-on-one', coach: coaches[0].id, dows: [6], time: '16:00', duration: 45, capacity: 1, trial: 500, monthly: 8000, format: SessionFormat.one_on_one },
    // These two run at the second location, so earnings split across branches.
    { program: keys, name: 'Beginners', coach: coaches[1].id, dows: [2, 4], time: '17:00', duration: 60, capacity: 6, trial: 200, monthly: 3500, branch: `${academyId}-b2` },
    { program: vocals, name: 'Women only · Online', coach: coaches[2].id, dows: [1, 4], time: '19:00', duration: 45, capacity: 12, trial: 100, monthly: 2400, mode: BatchMode.online, gender: BatchGender.female_only, branch: `${academyId}-b2` },
  ];

  // A second location, so the brand is genuinely multi-branch: the branch switcher, the
  // per-branch staff scopes and the Earnings "By branch" split all need more than one to mean
  // anything. It shares the brand's financial entity — a branch never gets a payout account of
  // its own (see academy-app/app/branches/new.tsx).
  const branch2 = await prisma.academy.upsert({
    where: { id: `${academyId}-b2` },
    update: {},
    create: {
      id: `${academyId}-b2`,
      groupId,
      financialEntityId,
      name: branch.name,
      branchLabel: 'Noida',
      category: branch.category,
      categories: branch.categories?.length ? branch.categories : [branch.category],
      address: 'Sector 18, Noida 201301',
      lat: 28.5708,
      lng: 77.321,
      status: branch.status,
      verified: branch.verified,
      modesOffered: branch.modesOffered,
    },
  });

  const batches = [];
  for (const s of specs) {
    const b = await prisma.batch.create({
      data: {
        academyId: s.branch ?? academyId,
        programId: s.program.id,
        coachId: s.coach,
        // title/category are still denormalised on Batch (expand→migrate→contract).
        title: s.program.title,
        category: Category.music,
        name: s.name,
        minAge: s.minAge ?? null,
        maxAge: s.maxAge ?? null,
        sessionFormat: s.format ?? SessionFormat.group,
        gender: s.gender ?? BatchGender.anyone,
        description: `${s.program.title} — ${s.name}.`,
        thingsToKnow: ['Bring your own instrument if you have one'],
        capacity: s.capacity,
        trialFeePaise: rupees(s.trial),
        monthlyFeePaise: rupees(s.monthly),
        sessionsPerMonth: s.dows.length * 4,
        mode: s.mode ?? BatchMode.offline,
        status: BatchStatus.active,
        timings: {
          create: s.dows.map((d) => ({ dayOfWeek: d, startTime: s.time, durationMin: s.duration })),
        },
      },
    });
    batches.push({ ...b, dows: s.dows, time: s.time, monthly: s.monthly, trial: s.trial });
  }
  console.log(`  ${coaches.length} coaches · ${staffPlan.length} people · 3 programs · ${batches.length} batches`);

  // ---------- students ----------
  const students = [];
  for (let i = 0; i < STUDENTS.length; i++) {
    const s = STUDENTS[i];
    students.push(
      await prisma.user.create({
        data: {
          phone: `${DEMO_PHONE_PREFIX}${String(100000 + i).slice(-6)}`,
          name: s.name,
          age: s.age,
          location: 'New Delhi',
          lat: 28.53,
          lng: 77.21,
          interests: [Category.music],
          avatarInitial: s.name[0].toUpperCase(),
          attendanceOtp: String(1000 + i * 137).slice(-4),
          ...selfLearnerCreate({
            name: s.name,
            avatarInitial: s.name[0].toUpperCase(),
            attendanceOtp: String(1000 + i * 137).slice(-4),
          }),
        },
      }),
    );
  }

  // ---------- enrolments (+ periods, payments, commission) ----------
  async function enrol(
    userId: string,
    batch: (typeof batches)[number],
    opts: {
      status?: EnrollmentStatus;
      startedDaysAgo: number;
      months: number;
      pausedUntilDays?: number;
      ended?: boolean;
      /** Left mid-period — drives the "Left 18 Jul" row on the batch screen. */
      leftDaysAgo?: number;
    },
  ) {
    const enrollment = await prisma.enrollment.create({
      data: {
        userId,
        learnerId: await learnerOf(userId),
        batchId: batch.id,
        status: opts.leftDaysAgo ? EnrollmentStatus.inactive : opts.status ?? EnrollmentStatus.active,
        defaultPackage: EnrollmentPackage.monthly,
        startedAt: at(-opts.startedDaysAgo, 11),
        pausedUntil: opts.pausedUntilDays ? at(opts.pausedUntilDays, 0) : null,
        discontinueRequestedAt: opts.leftDaysAgo ? at(-opts.leftDaysAgo, 11) : null,
      },
    });
    const start = dayOffset(-opts.startedDaysAgo);
    const end = dayOffset(-opts.startedDaysAgo + opts.months * 30);
    const period = await prisma.enrollmentPeriod.create({
      data: {
        enrollmentId: enrollment.id,
        packageType: EnrollmentPackage.monthly,
        startDate: dateOnly(start),
        endDate: dateOnly(end),
        amountPaise: rupees(batch.monthly * opts.months),
        status: opts.ended ? EnrollmentPeriodStatus.expired : EnrollmentPeriodStatus.active,
        discontinueRequestedAt: opts.leftDaysAgo ? at(-opts.leftDaysAgo, 11) : null,
        discontinueEffectiveAt: opts.leftDaysAgo ? at(-opts.leftDaysAgo, 11) : null,
      },
    });
    // A pause is an EnrollmentPause row, not just `pausedUntil`: that row is what the attendance
    // denominator reads, so a paused student's % must not keep falling.
    if (opts.pausedUntilDays) {
      await prisma.enrollmentPause.create({
        data: {
          enrollmentId: enrollment.id,
          // Charged to the paid period: the pause allowance is per period, so an unattributed
          // pause would show a paused student a full, untouched allowance.
          enrollmentPeriodId: period.id,
          // `one_week`, not two: these demo enrolments are all `monthly`, whose allowance is a
          // single week — a 2-week row would render as over-quota in the app.
          duration: PauseDuration.one_week,
          status: PauseStatus.active,
          startDate: at(-2, 0),
          endDate: at(opts.pausedUntilDays, 0),
          approvedAt: at(-2, 11),
        },
      });
    }
    if (!opts.ended) {
      await prisma.enrollment.update({ where: { id: enrollment.id }, data: { currentPeriodId: period.id } });
    }

    const gross = rupees(batch.monthly * opts.months);
    await prisma.enrollmentPayment.create({
      data: {
        enrollmentPeriodId: period.id,
        amountPaise: gross,
        razorpayOrderId: `order_demo_${period.id}`,
        razorpayPaymentId: `pay_demo_${period.id}`,
        status: PaymentStatus.captured,
        idempotencyKey: `demo_enrol_${period.id}`,
        capturedAt: at(-opts.startedDaysAgo, 12),
      },
    });
    await prisma.commissionLedger.create({
      data: {
        // The branch the money came from — not the brand's default location.
        academyId: batch.academyId,
        financialEntityId,
        itemType: CommissionItemType.enrollment,
        itemId: period.id,
        grossPaise: gross,
        commissionBps: COMMISSION_BPS,
        commissionPaise: Math.round((gross * COMMISSION_BPS) / 10000),
        status: CommissionStatus.accrued,
      },
    });
    return enrollment;
  }

  // Weekday Evening carries the roster; the rest get one or two each.
  const weekday = batches[0];
  for (let i = 0; i < 4; i++) {
    await enrol(students[i].id, weekday, { startedDaysAgo: 40 - i * 5, months: 3 });
  }
  // A student who left mid-period: their past sessions stay in the record (a leaver's low
  // attendance is often exactly why they left), nothing after the day they left.
  await enrol(students[4].id, weekday, { startedDaysAgo: 20, months: 3, leftDaysAgo: 6 });
  await enrol(students[5].id, batches[1], { startedDaysAgo: 20, months: 1 });
  await enrol(students[6].id, batches[3], { startedDaysAgo: 25, months: 1, pausedUntilDays: 12 });
  await enrol(students[7].id, batches[4], { startedDaysAgo: 15, months: 1 });
  // A finished enrolment, so "Past" has something in it.
  await enrol(students[6].id, weekday, { startedDaysAgo: 200, months: 3, status: EnrollmentStatus.inactive, ended: true });

  // ---------- sessions + attendance ----------
  // Sessions are records now (ClassSession) and absence is a written fact, so this seed IS the
  // fixture for the attendance screens: it deliberately lays down all four session states —
  // held/full, held/partial, cancelled, and not-recorded — so every screen shows each of them on
  // first run. See ai-usage/attendance-tracking_plan.md decision 13.
  let sessionRows = 0;
  let attendanceRows = 0;

  /** Deterministic, evenly-spread "did they show up" — no Math.random, so runs are comparable. */
  const showedUp = (studentIndex: number, sessionIndex: number, rate: number) =>
    ((sessionIndex * 37 + studentIndex * 11) % 100) / 100 < rate;

  /** A roster entry mirrors the enrolment: rows are only written for days the student was there
   *  to be counted (after they joined, before they left) — the same rule the closer applies. */
  type RosterEntry = { userId: string; rate: number; startedDaysAgo?: number; leftDaysAgo?: number };

  async function seedSessions(
    batch: (typeof batches)[number],
    roster: RosterEntry[],
    count: number,
    marks: { fullIndex?: number; cancelledIndex?: number; notRecordedIndex?: number } = {},
  ) {
    const occurrences = pastOccurrences(batch.dows, count); // newest first
    const closeAt = (d: Date) => new Date(d.getTime() + 20 * 60 * 60 * 1000); // ~2h after class

    for (let j = 0; j < occurrences.length; j++) {
      const date = dateOnly(occurrences[j]);

      // Cancelled: visible in the list, out of every denominator. No attendance rows.
      if (j === marks.cancelledIndex) {
        await prisma.classSession.create({
          data: { batchId: batch.id, sessionDate: date, status: 'cancelled', reason: 'Coach travelling' },
        });
        sessionRows++;
        continue;
      }

      // Not recorded: the teacher never showed the QR. Held, but never finalised and with zero
      // attendance rows — so it reads "Not recorded" rather than marking a whole batch absent.
      if (j === marks.notRecordedIndex) {
        await prisma.classSession.create({
          data: { batchId: batch.id, sessionDate: date, status: 'held', finalisedAt: null },
        });
        sessionRows++;
        continue;
      }

      await prisma.classSession.create({
        data: { batchId: batch.id, sessionDate: date, status: 'held', finalisedAt: closeAt(occurrences[j]) },
      });
      sessionRows++;

      for (let i = 0; i < roster.length; i++) {
        const { userId, rate, startedDaysAgo, leftDaysAgo } = roster[i];
        if (startedDaysAgo !== undefined && occurrences[j] < dayOffset(-startedDaysAgo)) continue;
        if (leftDaysAgo !== undefined && occurrences[j] > dayOffset(-leftDaysAgo)) continue;
        const present = j === marks.fullIndex || showedUp(i, j, rate);
        await prisma.batchAttendance.create({
          data: {
            batchId: batch.id,
            userId,
            learnerId: await learnerOf(userId),
            date,
            present,
            // Presence is the student's own check-in (null); absence is written by the closer.
            markedByAccountId: present ? null : 'system',
            markedAt: present
              ? new Date(date.getTime() + 18 * 60 * 60 * 1000)
              : closeAt(occurrences[j]),
          },
        });
        attendanceRows++;
      }
    }
  }

  // The roster batch: 20 sessions (spanning two calendar months, so the month switcher has
  // something on either side) with rates that produce all three tiers.
  await seedSessions(
    weekday,
    [
      { userId: students[0].id, rate: 1 },
      { userId: students[1].id, rate: 0.92 },
      { userId: students[2].id, rate: 0.58 },
      { userId: students[3].id, rate: 0.5 },
      { userId: students[4].id, rate: 0.25, startedDaysAgo: 20, leftDaysAgo: 6 },
    ],
    20,
    { fullIndex: 1, cancelledIndex: 2, notRecordedIndex: 3 },
  );
  // The other batches get a shorter, healthier history so L1 has more than one row.
  await seedSessions(batches[1], [{ userId: students[5].id, rate: 0.85 }], 8, { notRecordedIndex: 1 });
  await seedSessions(batches[3], [{ userId: students[6].id, rate: 0.8 }], 8, { cancelledIndex: 3 });
  await seedSessions(batches[4], [{ userId: students[7].id, rate: 0.95 }], 8);

  // ---------- trials: upcoming (Inbox) + past outcomes ----------
  async function trial(userId: string, batch: (typeof batches)[number], trialAt: Date, status: TrialStatus) {
    const booking = await prisma.booking.create({
      data: {
        userId,
        learnerId: await learnerOf(userId),
        batchId: batch.id,
        trialAt,
        status: status === TrialStatus.cancelled ? BookingStatus.cancelled : BookingStatus.confirmed,
        reservationExpiresAt: trialAt,
        paidAt: new Date(trialAt.getTime() - DAY),
      },
    });
    const gross = rupees(batch.trial);
    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        amountPaise: gross,
        razorpayOrderId: `order_demo_trial_${booking.id}`,
        razorpayPaymentId: `pay_demo_trial_${booking.id}`,
        status: PaymentStatus.captured,
        idempotencyKey: `demo_trial_${booking.id}`,
        capturedAt: new Date(trialAt.getTime() - DAY),
      },
    });
    await prisma.commissionLedger.create({
      data: {
        academyId,
        financialEntityId,
        itemType: CommissionItemType.trial,
        itemId: booking.id,
        grossPaise: gross,
        commissionBps: COMMISSION_BPS,
        commissionPaise: Math.round((gross * COMMISSION_BPS) / 10000),
        status: CommissionStatus.accrued,
      },
    });
    return prisma.trial.create({
      data: {
        userId,
        learnerId: await learnerOf(userId),
        academyId,
        batchId: batch.id,
        bookingId: booking.id,
        trialAt,
        status,
        attendanceMarkedAt: status === TrialStatus.attended ? new Date(trialAt.getTime() + 3600_000) : null,
      },
    });
  }

  // Upcoming — these are what the Inbox asks the academy to act on.
  await trial(students[5].id, weekday, nextOccurrence(1, 18), TrialStatus.booked);
  await trial(students[6].id, batches[3], nextOccurrence(2, 17), TrialStatus.booked);
  await trial(students[7].id, batches[4], nextOccurrence(4, 19), TrialStatus.booked);
  // Past outcomes.
  const attended = await trial(students[0].id, weekday, at(-9, 18), TrialStatus.attended);
  await trial(students[1].id, batches[1], at(-14, 10), TrialStatus.attended);
  await trial(students[2].id, batches[3], at(-6, 17), TrialStatus.no_show);

  // ---------- reviews (and reconcile the academy's rating to them) ----------
  const reviewTexts: [number, string][] = [
    [5, 'Varun breaks everything down. I could play a full song in three weeks.'],
    [5, 'Small batches, so you actually get corrected. Worth the fee.'],
    [4, 'Great teaching. Studio can get warm in the evenings.'],
    [4, 'My daughter looks forward to the weekend class, which says it all.'],
    [5, 'Online vocals worked better than I expected — clear audio, real feedback.'],
  ];
  for (let i = 0; i < reviewTexts.length; i++) {
    const [rating, comment] = reviewTexts[i];
    await prisma.review.create({
      data: {
        userId: students[i].id,
        academyId,
        batchId: weekday.id,
        trialId: i === 0 ? attended.id : null,
        source: i === 0 ? 'trial' : 'enrollment',
        rating,
        comment,
        // One unanswered review, so "needs reply" isn't empty.
        response: i === 1 ? 'Thank you! See you Wednesday.' : null,
        respondedAt: i === 1 ? at(-3, 20) : null,
      },
    });
  }
  const all = await prisma.review.findMany({ where: { academyId }, select: { rating: true } });
  await prisma.academy.update({
    where: { id: academyId },
    data: {
      rating: Math.round((all.reduce((s, r) => s + r.rating, 0) / all.length) * 10) / 10,
      ratingCount: all.length,
    },
  });

  // ---------- class notes on the two most recent past sessions ----------
  const noteDates = pastOccurrences(weekday.dows, 2);
  await prisma.classNote.create({
    data: {
      batchId: weekday.id,
      sessionDate: dateOnly(noteDates[0]),
      body: 'Barre chords (F, B minor) and the 1-4-5 change. Practise 10 minutes daily — clean fretting before speed.',
      createdByAccountId: account.id,
    },
  });
  await prisma.classNote.create({
    data: {
      batchId: weekday.id,
      sessionDate: dateOnly(noteDates[1]),
      body: 'Warm-ups plus the down-down-up-up-down-up strumming pattern at 70 bpm. No handout this week.',
      createdByAccountId: account.id,
    },
  });

  console.log(
    `  ${students.length} students · 9 enrolments · ${sessionRows} sessions · ${attendanceRows} attendance rows · 6 trials · ${all.length} reviews · 2 class notes`,
  );
  console.log('▸ done. Open the academy app — Home, Schedule, Students, Studio and Earnings all have data now.');
}

/** Remove only this academy's rows, plus the demo students this script creates. */
async function wipe(academyId: string) {
  const batchIds = (await prisma.batch.findMany({ where: { academyId }, select: { id: true } })).map((b) => b.id);
  const demoUserIds = (
    await prisma.user.findMany({ where: { phone: { startsWith: DEMO_PHONE_PREFIX } }, select: { id: true } })
  ).map((u) => u.id);

  const enrollmentIds = (
    await prisma.enrollment.findMany({ where: { batchId: { in: batchIds } }, select: { id: true } })
  ).map((e) => e.id);
  const periodIds = (
    await prisma.enrollmentPeriod.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: { id: true } })
  ).map((p) => p.id);
  const bookingIds = (
    await prisma.booking.findMany({ where: { batchId: { in: batchIds } }, select: { id: true } })
  ).map((b) => b.id);

  await prisma.classNoteFile.deleteMany({ where: { classNote: { batchId: { in: batchIds } } } });
  await prisma.classNote.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.batchAttendance.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.review.deleteMany({ where: { academyId } });
  await prisma.trial.deleteMany({ where: { academyId } });
  await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
  await prisma.enrollmentPayment.deleteMany({ where: { enrollmentPeriodId: { in: periodIds } } });
  await prisma.sessionCredit.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.enrollmentPause.deleteMany({ where: { enrollmentId: { in: enrollmentIds } } });
  await prisma.batchTransferRequest.deleteMany({
    where: { OR: [{ fromEnrollmentId: { in: enrollmentIds } }, { toBatchId: { in: batchIds } }] },
  });
  await prisma.enrollmentPeriod.deleteMany({ where: { id: { in: periodIds } } });
  await prisma.enrollment.deleteMany({ where: { id: { in: enrollmentIds } } });
  await prisma.classSession.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.sessionReminderSent.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.slot.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.batchTiming.deleteMany({ where: { batchId: { in: batchIds } } });
  await prisma.commissionLedger.deleteMany({ where: { academyId } });
  await prisma.batch.deleteMany({ where: { academyId } });
  // The seeded second location and everything hanging off it.
  const branch2Id = `${academyId}-b2`;
  await prisma.commissionLedger.deleteMany({ where: { academyId: branch2Id } });
  await prisma.batch.deleteMany({ where: { academyId: branch2Id } });
  await prisma.staffBranchScope.deleteMany({ where: { academyId: branch2Id } });
  await prisma.academy.deleteMany({ where: { id: branch2Id } });
  // Programs and coaches are BRAND-level. Scope the wipe to the branch's group, and only
  // after its batches are gone (they FK onto both).
  const groupId = (await prisma.academy.findUnique({ where: { id: academyId }, select: { groupId: true } }))?.groupId;
  if (groupId) {
    await prisma.programMedia.deleteMany({ where: { program: { groupId } } });
    await prisma.program.deleteMany({ where: { groupId } });
    // Staff before coaches: an assignment FKs onto the coach it teaches as.
    await prisma.staffBranchScope.deleteMany({ where: { assignment: { staff: { groupId } } } });
    await prisma.staffRoleAssignment.deleteMany({ where: { staff: { groupId } } });
    await prisma.staffAccount.deleteMany({ where: { groupId } });
    await prisma.coach.deleteMany({ where: { groupId } });
  }
  const learners = await prisma.guardianship.findMany({ where: { userId: { in: demoUserIds } }, select: { learnerId: true } });
  await prisma.guardianship.deleteMany({ where: { userId: { in: demoUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: demoUserIds } } });
  await prisma.learner.deleteMany({ where: { id: { in: learners.map((l) => l.learnerId) } } });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
