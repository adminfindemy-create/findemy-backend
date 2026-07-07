import {
  PrismaClient,
  Category,
  BatchMode,
  WorkshopType,
  EventType,
  TrialStatus,
  BookingStatus,
  EnrollmentStatus,
  EnrollmentPackage,
  EnrollmentPeriodStatus,
} from '@prisma/client';
import { istDateKey, istWallClockToUtc } from '../src/lib/ist.js';

const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);
const atHour = (d: number, h: number) => {
  const dt = daysFromNow(d);
  dt.setHours(h, 0, 0, 0);
  return dt;
};

// --- Wipe existing domain data (children → parents) so the seed is repeatable. ---
async function wipe() {
  await prisma.review.deleteMany();
  await prisma.batchAttendance.deleteMany();
  await prisma.trial.deleteMany();
  await prisma.enrollmentPayment.deleteMany();
  await prisma.workshopPayment.deleteMany();
  await prisma.eventPayment.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.workshopRegistration.deleteMany();
  await prisma.eventRegistration.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.batchTransferRequest.deleteMany();
  await prisma.enrollmentPause.deleteMany();
  await prisma.enrollmentPeriod.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.slot.deleteMany();
  await prisma.batchTiming.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.programMedia.deleteMany();
  await prisma.program.deleteMany();
  await prisma.coach.deleteMany();
  await prisma.workshop.deleteMany();
  await prisma.event.deleteMany();
  await prisma.savedAcademy.deleteMany();
  await prisma.expoPushToken.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.academyAccount.deleteMany();
  await prisma.academy.deleteMany();
  await prisma.user.deleteMany();
}

type BatchSpec = {
  level: string;
  mode: BatchMode;
  capacity: number;
  trialFeePaise: number;
  monthlyFeePaise: number;
  // S1.3: academy-set discounts in bps (≤3000). Demo values on the featured academy.
  quarterlyDiscountBps?: number;
  annualDiscountBps?: number;
  timings: { dayOfWeek: number; startTime: string; durationMin: number }[];
};

// A named offering. Owns the identity/marketing copy; holds one or more batches.
type ProgramSpec = {
  title: string;
  description: string;
  thingsToKnow?: string[];
  batches: BatchSpec[];
};

type AcademySpec = {
  name: string;
  category: Category;
  address: string;
  lat: number;
  lng: number;
  verified: boolean;
  onlineAvailable: boolean;
  rating: number;
  ratingCount: number;
  bio: string;
  accountPhone: string;
  coaches: { name: string; specialty: string; bio: string; phone: string }[];
  programs: ProgramSpec[];
};

const t = (dayOfWeek: number, startTime: string, durationMin = 60) => ({
  dayOfWeek,
  startTime,
  durationMin,
});

const ACADEMIES: AcademySpec[] = [
  {
    name: 'The Rhythm House',
    category: Category.music,
    address: '12 Hauz Khas Village, New Delhi 110016',
    lat: 28.5494, lng: 77.2001, verified: true, onlineAvailable: true, rating: 4.8, ratingCount: 124,
    bio: 'Guitar, piano, and vocals from working musicians. Graded curriculum, recitals every term.',
    accountPhone: '9876500010',
    coaches: [
      { name: 'Ravi Kumar', specialty: 'Guitar · 10 yrs', bio: 'Trinity College London graduate.', phone: '+919876500110' },
      { name: 'Anita Desai', specialty: 'Piano · 8 yrs', bio: 'Classical pianist and examiner.', phone: '+919876500111' },
    ],
    programs: [
      {
        title: 'Guitar',
        description: 'Learn acoustic and electric guitar from working musicians — chords, technique, and songs you actually want to play.',
        thingsToKnow: ['Bring your own guitar', 'Arrive 10 minutes early', 'All ages welcome'],
        batches: [
          { level: 'Beginner', mode: BatchMode.offline, capacity: 8, trialFeePaise: 9900, monthlyFeePaise: 299900, quarterlyDiscountBps: 1000, annualDiscountBps: 2000, timings: [t(6, '10:00'), t(0, '10:00')] },
        ],
      },
      {
        title: 'Piano',
        description: 'Graded piano lessons from a classical examiner — sight-reading, theory, and performance, online.',
        thingsToKnow: ['A weighted keyboard or piano at home is recommended', 'Live online sessions'],
        batches: [
          { level: 'Intermediate', mode: BatchMode.online, capacity: 6, trialFeePaise: 0, monthlyFeePaise: 349900, quarterlyDiscountBps: 1000, annualDiscountBps: 2000, timings: [t(2, '18:00'), t(4, '18:00')] },
        ],
      },
    ],
  },
  {
    name: 'Saptak School of Music',
    category: Category.music,
    address: 'Lajpat Nagar II, New Delhi 110024',
    lat: 28.5677, lng: 77.2433, verified: true, onlineAvailable: true, rating: 4.6, ratingCount: 72,
    bio: 'Hindustani vocals and tabla in a traditional guru-shishya setting.',
    accountPhone: '9876500020',
    coaches: [{ name: 'Pandit Sharma', specialty: 'Hindustani Vocals · 20 yrs', bio: 'Performing artist for two decades.', phone: '+919876500120' }],
    programs: [
      {
        title: 'Hindustani Vocals',
        description: 'Classical Hindustani vocal training in a traditional guru-shishya setting — ragas, taals, and breath control.',
        thingsToKnow: ['Morning classes', 'No prior experience needed'],
        batches: [
          { level: 'Beginner', mode: BatchMode.offline, capacity: 10, trialFeePaise: 5000, monthlyFeePaise: 250000, timings: [t(6, '08:00'), t(0, '08:00')] },
        ],
      },
    ],
  },
  {
    name: 'Step Up Dance Studio',
    category: Category.dance,
    address: 'Saket District Centre, New Delhi 110017',
    lat: 28.5245, lng: 77.2066, verified: true, onlineAvailable: false, rating: 4.7, ratingCount: 47,
    bio: 'Bharatanatyam, Bollywood, and contemporary — disciplined classical foundations.',
    accountPhone: '9876500030',
    coaches: [{ name: 'Meera Iyer', specialty: 'Bharatanatyam · 14 yrs', bio: 'Performed across India; 200+ students.', phone: '+919876500130' }],
    programs: [
      {
        title: 'Bharatanatyam',
        description: 'Classical Bharatanatyam with disciplined foundations — adavus, mudras, and expressive abhinaya.',
        thingsToKnow: ['Wear comfortable practice clothes', 'Barefoot practice'],
        batches: [
          { level: 'Beginner', mode: BatchMode.offline, capacity: 12, trialFeePaise: 10000, monthlyFeePaise: 180000, timings: [t(6, '17:00'), t(0, '17:00')] },
        ],
      },
      {
        title: 'Bollywood',
        description: 'High-energy Bollywood choreography for all levels — learn a new routine every few weeks.',
        thingsToKnow: ['All levels welcome', 'Comfortable shoes recommended'],
        batches: [
          { level: 'All levels', mode: BatchMode.offline, capacity: 15, trialFeePaise: 0, monthlyFeePaise: 160000, timings: [t(5, '19:00')] },
        ],
      },
    ],
  },
  {
    name: 'Beats & Moves Dance Co.',
    category: Category.dance,
    address: 'Sector 12, Dwarka, New Delhi 110078',
    lat: 28.5921, lng: 77.0460, verified: false, onlineAvailable: true, rating: 4.5, ratingCount: 38,
    bio: 'Hip-hop, street, and contemporary crews. Battles and showcases each season.',
    accountPhone: '9876500040',
    coaches: [{ name: 'Karan Mehta', specialty: 'Hip-Hop · 9 yrs', bio: 'Choreographer and battle judge.', phone: '+919876500140' }],
    programs: [
      {
        title: 'Hip-Hop',
        description: 'Street and hip-hop foundations — grooves, isolations, and choreography, building toward battles and showcases.',
        thingsToKnow: ['Wear sneakers', 'Come warmed up'],
        batches: [
          { level: 'Beginner', mode: BatchMode.offline, capacity: 16, trialFeePaise: 7500, monthlyFeePaise: 200000, timings: [t(1, '19:30'), t(3, '19:30')] },
        ],
      },
    ],
  },
  {
    name: 'Kalapatra Studio',
    category: Category.arts,
    address: '5 Green Park, New Delhi 110016',
    lat: 28.5583, lng: 77.2065, verified: true, onlineAvailable: true, rating: 4.6, ratingCount: 32,
    bio: 'Watercolours, oils and sketching — for all ages.',
    accountPhone: '9876500050',
    coaches: [{ name: 'Arjun Rao', specialty: 'Watercolour · 8 yrs', bio: 'Fine-arts graduate and exhibiting artist.', phone: '+919876500150' }],
    programs: [
      {
        title: 'Watercolour',
        description: 'Watercolour painting for all ages — washes, colour theory, and composition with an exhibiting artist.',
        thingsToKnow: ['Materials provided for the first class', 'Aprons recommended'],
        batches: [
          { level: 'Beginner', mode: BatchMode.offline, capacity: 12, trialFeePaise: 0, monthlyFeePaise: 250000, timings: [t(6, '11:00', 90)] },
        ],
      },
      {
        title: 'Sketching',
        description: 'Pencil and ink sketching fundamentals delivered live online — line, form, light, and shade.',
        thingsToKnow: ['Bring a sketchbook and pencils', 'Live online sessions'],
        batches: [
          { level: 'Beginner', mode: BatchMode.online, capacity: 20, trialFeePaise: 0, monthlyFeePaise: 150000, timings: [t(0, '16:00', 90)] },
        ],
      },
    ],
  },
  {
    name: 'Canvas & Clay Atelier',
    category: Category.arts,
    address: 'Vasant Kunj, New Delhi 110070',
    lat: 28.5200, lng: 77.1591, verified: true, onlineAvailable: false, rating: 4.4, ratingCount: 19,
    bio: 'Pottery, ceramics, and mixed-media for hobbyists and serious makers.',
    accountPhone: '9876500060',
    coaches: [{ name: 'Sneha Pillai', specialty: 'Pottery · 6 yrs', bio: 'Studio potter and ceramicist.', phone: '+919876500160' }],
    programs: [
      {
        title: 'Pottery',
        description: 'Hand-building and wheel-throwing for hobbyists and serious makers — weekend studio sessions.',
        thingsToKnow: ['Clay and tools provided', 'Wear clothes you can get messy'],
        batches: [
          { level: 'Beginner', mode: BatchMode.offline, capacity: 8, trialFeePaise: 15000, monthlyFeePaise: 320000, timings: [t(6, '15:00', 120)] },
        ],
      },
    ],
  },
  {
    name: 'Shanti Yoga Mandir',
    category: Category.yoga,
    address: 'Defence Colony, New Delhi 110024',
    lat: 28.5733, lng: 77.2310, verified: false, onlineAvailable: true, rating: 4.6, ratingCount: 51,
    bio: 'Hatha and Ashtanga yoga — dawn and dusk classes.',
    accountPhone: '9876500070',
    coaches: [{ name: 'Lakshmi Nair', specialty: 'Hatha Yoga · 12 yrs', bio: 'Certified instructor, decade of teaching.', phone: '+919876500170' }],
    programs: [
      {
        title: 'Hatha Yoga',
        description: 'Hatha and Ashtanga yoga for all levels — asanas, alignment, and breath, dawn and dusk.',
        thingsToKnow: ['Bring your own mat', 'Practice on an empty stomach'],
        batches: [
          { level: 'All levels', mode: BatchMode.offline, capacity: 20, trialFeePaise: 0, monthlyFeePaise: 150000, timings: [t(1, '06:30'), t(3, '06:30'), t(5, '06:30')] },
        ],
      },
    ],
  },
  {
    name: 'Prana Flow Studio',
    category: Category.yoga,
    address: 'Connaught Place, New Delhi 110001',
    lat: 28.6315, lng: 77.2167, verified: true, onlineAvailable: true, rating: 4.9, ratingCount: 88,
    bio: 'Vinyasa flow, breathwork, and meditation. Small heated studio sessions.',
    accountPhone: '9876500080',
    coaches: [{ name: 'Dev Anand', specialty: 'Vinyasa · 11 yrs', bio: 'RYT-500, breathwork facilitator.', phone: '+919876500180' }],
    programs: [
      {
        title: 'Vinyasa Flow',
        description: 'Vinyasa flow, breathwork, and meditation in small heated online sessions — build strength and focus.',
        thingsToKnow: ['Bring a mat and water', 'Live online sessions'],
        batches: [
          { level: 'Intermediate', mode: BatchMode.online, capacity: 25, trialFeePaise: 0, monthlyFeePaise: 180000, timings: [t(2, '07:00'), t(4, '07:00'), t(6, '08:00')] },
        ],
      },
    ],
  },
];

type CreatedBatch = { id: string; academyId: string; slotIds: string[] };

// Cover photos lifted from the student-app prototype (Unsplash). Two per
// category so the two seeded academies in each category look distinct.
const CATEGORY_COVERS: Record<string, string[]> = {
  music: ['photo-1511379938547-c1f69419868d', 'photo-1470225620780-dba8ba36b745'],
  dance: ['photo-1508700115892-45ecd05ae2ad', 'photo-1547153760-18fc86324498'],
  arts: ['photo-1460661419201-fd4cecdf8a8b', 'photo-1565193566173-7a0ee3dbe261'],
  yoga: ['photo-1506126613408-eca07ce68773', 'photo-1544367567-0f2fcb009e0b'],
};
const coverUrl = (id: string) => `https://images.unsplash.com/${id}?w=800&h=600&q=80&auto=format&fit=crop`;

// 3 demo photos per program (min-3 media rule). Reuses category cover ids + one extra each.
const PROGRAM_PHOTOS: Record<string, string[]> = {
  music: ['photo-1511379938547-c1f69419868d', 'photo-1470225620780-dba8ba36b745', 'photo-1493225457124-a3eb161ffa5f'],
  dance: ['photo-1508700115892-45ecd05ae2ad', 'photo-1547153760-18fc86324498', 'photo-1518834107812-67b0b7c58434'],
  arts: ['photo-1460661419201-fd4cecdf8a8b', 'photo-1565193566173-7a0ee3dbe261', 'photo-1513364776144-60967b0f800f'],
  yoga: ['photo-1506126613408-eca07ce68773', 'photo-1544367567-0f2fcb009e0b', 'photo-1552196563-55cd4e45efb3'],
};

async function seedCatalog() {
  const academies: { id: string; name: string; category: Category; batches: CreatedBatch[] }[] = [];
  const catCounter: Record<string, number> = {};

  for (const spec of ACADEMIES) {
    const covers = CATEGORY_COVERS[spec.category] ?? [];
    const idx = catCounter[spec.category] ?? 0;
    catCounter[spec.category] = idx + 1;
    const images = covers.length ? [coverUrl(covers[idx % covers.length])] : [];

    const academy = await prisma.academy.create({
      data: {
        name: spec.name,
        category: spec.category,
        address: spec.address,
        lat: spec.lat,
        lng: spec.lng,
        verified: spec.verified,
        onlineAvailable: spec.onlineAvailable,
        rating: spec.rating,
        ratingCount: spec.ratingCount,
        bio: spec.bio,
        images,
      },
    });

    await prisma.academyAccount.create({
      data: { phone: spec.accountPhone, academyId: academy.id },
    });

    const coaches = [];
    for (const c of spec.coaches) {
      coaches.push(
        await prisma.coach.create({
          data: { academyId: academy.id, name: c.name, specialty: c.specialty, bio: c.bio, phone: c.phone },
        }),
      );
    }

    // Programs own the identity/marketing copy; batches are created under a program.
    // `batches` stays flattened (program order, then batch order) so downstream seed code
    // that indexes academy.batches[0]/[1] is unchanged. Coach assignment uses the flat index.
    const batches: CreatedBatch[] = [];
    let batchIdx = 0;
    for (const p of spec.programs) {
      const photos = PROGRAM_PHOTOS[spec.category] ?? [];
      const program = await prisma.program.create({
        data: {
          academyId: academy.id,
          title: p.title,
          category: spec.category,
          description: p.description,
          thingsToKnow: p.thingsToKnow ?? [],
          media: {
            create: photos.map((id, i) => ({ url: coverUrl(id), type: 'photo', order: i })),
          },
        },
      });
      for (const b of p.batches) {
        const coach = coaches[batchIdx % coaches.length];
        batchIdx++;
        const batch = await prisma.batch.create({
          data: {
            academyId: academy.id,
            programId: program.id,
            coachId: coach.id,
            // Denormalized from the program until the contract slice (see schema note).
            title: `${p.title} · ${b.level}`,
            category: spec.category,
            level: b.level,
            description: p.description,
            thingsToKnow: p.thingsToKnow ?? [],
            capacity: b.capacity,
            trialFeePaise: b.trialFeePaise,
            monthlyFeePaise: b.monthlyFeePaise,
            quarterlyDiscountBps: b.quarterlyDiscountBps ?? 0,
            annualDiscountBps: b.annualDiscountBps ?? 0,
            mode: b.mode,
          },
        });
        await prisma.batchTiming.createMany({
          data: b.timings.map((tm) => ({ batchId: batch.id, ...tm })),
        });
        // bookable future slots (3, two days apart)
        const slotIds: string[] = [];
        for (let s = 0; s < 3; s++) {
          const slot = await prisma.slot.create({
            data: { batchId: batch.id, slotTime: atHour(2 + s * 2, 10), capacity: b.capacity, reservedCount: 1 },
          });
          slotIds.push(slot.id);
        }
        batches.push({ id: batch.id, academyId: academy.id, slotIds });
      }
    }

    academies.push({ id: academy.id, name: spec.name, category: spec.category, batches });
  }

  return academies;
}

let userSeq = 0;
async function createUser(name: string, phone: string | null, interests: Category[], otp?: string) {
  userSeq++;
  return prisma.user.create({
    data: {
      name,
      phone,
      interests,
      avatarInitial: name.slice(0, 2).toUpperCase(),
      // 6-digit to match the app's generateOtpCode() + attendance.test. The 4-digit
      // attendance OTP is S2.2's change (generator + seed + test together), not S0.4.
      // `otp` lets a caller pin a memorable code (used by the testable trial students).
      attendanceOtp: otp ?? (userSeq === 1 ? '4927' : String(1000 + userSeq).slice(0, 4)),
      location: 'New Delhi',
      lat: 28.5494,
      lng: 77.2001,
      age: 20 + (userSeq % 20),
    },
  });
}

// A completed, attended trial that carries a review — populates academy detail + ratings.
async function createReview(
  userId: string,
  academyId: string,
  batch: CreatedBatch,
  rating: number,
  comment: string,
  daysAgo: number,
) {
  const slot = await prisma.slot.create({
    data: { batchId: batch.id, slotTime: atHour(-daysAgo, 11), capacity: 8, reservedCount: 1, status: 'past' },
  });
  const booking = await prisma.booking.create({
    data: {
      userId,
      batchId: batch.id,
      slotId: slot.id,
      status: BookingStatus.confirmed,
      reservationExpiresAt: atHour(-daysAgo, 12),
      paidAt: atHour(-daysAgo, 9),
    },
  });
  const trial = await prisma.trial.create({
    data: {
      userId,
      academyId,
      batchId: batch.id,
      slotId: slot.id,
      bookingId: booking.id,
      trialAt: atHour(-daysAgo, 11),
      status: TrialStatus.attended,
      attendanceMarkedAt: atHour(-daysAgo, 12),
    },
  });
  await prisma.review.create({
    data: { userId, academyId, batchId: batch.id, trialId: trial.id, rating, comment },
  });
}

// An upcoming, auto-confirmed (booked) trial ready for the academy to "Mark attendance".
// slotId is legacy/optional — trialAt is canonical.
async function createBookedTrial(userId: string, academyId: string, batch: CreatedBatch, trialAt: Date) {
  const booking = await prisma.booking.create({
    data: {
      userId,
      batchId: batch.id,
      status: BookingStatus.confirmed,
      trialAt,
      reservationExpiresAt: trialAt,
      paidAt: new Date(),
    },
  });
  await prisma.trial.create({
    data: { userId, academyId, batchId: batch.id, bookingId: booking.id, trialAt, status: TrialStatus.booked },
  });
}

async function seedWorkshopsAndEvents(academies: { id: string; name: string; category: Category }[]) {
  const byCat = (c: Category) => academies.find((a) => a.category === c)!;

  const workshops: {
    academyId: string; type: WorkshopType; title: string; description: string;
    startAt: Date; durationMin: number; location: string | null; capacity: number; registeredCount: number; pricePaise: number;
  }[] = [
    { academyId: byCat(Category.music).id, type: WorkshopType.offline, title: 'Fingerstyle Guitar Masterclass', description: 'A 2-hour deep dive into fingerstyle technique and arrangement.', startAt: atHour(6, 17), durationMin: 120, location: 'Hauz Khas, New Delhi', capacity: 30, registeredCount: 18, pricePaise: 39900 },
    { academyId: byCat(Category.music).id, type: WorkshopType.online, title: 'Music Theory Crash Course', description: 'Scales, chords, and progressions for beginners — live online.', startAt: atHour(9, 19), durationMin: 90, location: null, capacity: 100, registeredCount: 54, pricePaise: 19900 },
    { academyId: byCat(Category.dance).id, type: WorkshopType.offline, title: 'Bollywood Dance Demo Session', description: 'Free taster session — learn a routine in 60 minutes.', startAt: atHour(4, 18), durationMin: 60, location: 'Saket, New Delhi', capacity: 25, registeredCount: 25, pricePaise: 0 },
    { academyId: byCat(Category.arts).id, type: WorkshopType.offline, title: 'Urban Sketching Walk', description: 'Sketch the city — bring a notebook, we provide the rest.', startAt: atHour(7, 9), durationMin: 180, location: 'Lodhi Garden, New Delhi', capacity: 15, registeredCount: 9, pricePaise: 29900 },
    { academyId: byCat(Category.yoga).id, type: WorkshopType.offline, title: 'Breathwork & Meditation Intensive', description: 'Pranayama techniques for stress and focus.', startAt: atHour(11, 7), durationMin: 90, location: 'Green Park, New Delhi', capacity: 20, registeredCount: 12, pricePaise: 24900 },
    { academyId: byCat(Category.yoga).id, type: WorkshopType.online, title: 'Morning Vinyasa Flow (Live)', description: 'Start your weekend with a guided flow, all levels.', startAt: atHour(8, 8), durationMin: 60, location: null, capacity: 80, registeredCount: 41, pricePaise: 14900 },
  ];
  const createdWorkshops = [];
  for (const w of workshops) createdWorkshops.push(await prisma.workshop.create({ data: w }));

  // Real registrations for The Rhythm House's workshops so the academy's "Who booked" list
  // is populated (registeredCount is reconciled to the actual confirmed rows).
  const musicWorkshops = createdWorkshops.filter((w) => w.academyId === byCat(Category.music).id);
  const attendeeNames = ['Kabir Sethi', 'Anaya Rao', 'Vivaan Shah', 'Myra Kapoor', 'Reyansh Gupta', 'Sara Qureshi'];
  let ai = 0;
  for (const w of musicWorkshops) {
    // Mostly confirmed+paid; one pending (awaiting payment) on a paid workshop to show statuses.
    const plan =
      w.pricePaise > 0
        ? [{ status: 'confirmed', paid: true }, { status: 'confirmed', paid: true }, { status: 'pending', paid: false }]
        : [{ status: 'confirmed', paid: false }, { status: 'confirmed', paid: false }, { status: 'confirmed', paid: false }];
    let confirmed = 0;
    for (const a of plan) {
      const u = await createUser(attendeeNames[ai % attendeeNames.length], `98765${43210 + ai}`, [Category.music]);
      ai++;
      const reg = await (prisma as any).workshopRegistration.create({
        data: { workshopId: w.id, userId: u.id, status: a.status },
      });
      if (a.paid && w.pricePaise > 0) {
        await (prisma as any).workshopPayment.create({
          data: {
            registrationId: reg.id,
            amountPaise: w.pricePaise,
            currency: 'INR',
            razorpayOrderId: `seed_ord_${reg.id}`,
            status: 'captured',
            idempotencyKey: `seed_idem_${reg.id}`,
            capturedAt: new Date(),
          },
        });
      }
      if (a.status === 'confirmed') confirmed++;
    }
    await prisma.workshop.update({ where: { id: w.id }, data: { registeredCount: confirmed } });
  }

  const events = [
    { type: EventType.competition, title: 'Delhi Dance Battle', category: Category.dance, description: '1v1 hip-hop battles across age categories. Bring your crew; judged by a panel of choreographers. Cash prizes for winners.', startAt: atHour(12, 16), endAt: atHour(12, 21), location: 'Dwarka, New Delhi', lat: 28.5921, lng: 77.0460, capacity: 64, enrolledCount: 48, pricePaise: 29900, organizerName: 'Findemy', coverColor: '#D8492A', registrationDeadline: atHour(10, 23), isSpotlight: true, prizePaise: 5000000, divisions: ['Sub-junior (8–12)', 'Junior (13–17)', 'Open (18+)'] },
    { type: EventType.talent_hunt, title: 'Findemy Utsav — Season 1', category: Category.music, description: 'A nationwide showcase across music, dance, arts and yoga.', startAt: atHour(16, 10), endAt: atHour(18, 18), location: 'All India · Online', lat: 12.9716, lng: 77.5946, capacity: 500, enrolledCount: 213, pricePaise: 0, organizerName: 'Findemy', coverColor: '#1A1614', registrationDeadline: atHour(14, 23), prizePaise: 10000000, divisions: ['Solo', 'Group'] },
    { type: EventType.meetup, title: 'Weekend Music Jam', category: Category.music, description: 'A relaxed jam session for beginners and pros alike.', startAt: atHour(7, 18), endAt: atHour(7, 20), location: 'Hauz Khas, New Delhi', lat: 28.5494, lng: 77.2001, capacity: 30, enrolledCount: 17, pricePaise: 0, organizerName: 'The Rhythm House', coverColor: '#1E5C5A', registrationDeadline: atHour(6, 23) },
    { type: EventType.meetup, title: 'Artists’ Open Studio', category: Category.arts, description: 'Bring your work-in-progress and create alongside others.', startAt: atHour(5, 15), endAt: atHour(5, 18), location: 'Green Park, New Delhi', lat: 28.5583, lng: 77.2065, capacity: 20, enrolledCount: 8, pricePaise: 0, organizerName: 'Kalapatra Studio', coverColor: '#5B2F3D', registrationDeadline: atHour(4, 23) },
  ];
  for (const e of events) await prisma.event.create({ data: e });
}

async function main() {
  await wipe();
  const academies = await seedCatalog();

  // S4.3: seed a realistic spread of REAL reviews per academy (distinct reviewers — one review
  // per (user, academy)), then set each academy's rating + ratingCount FROM those rows. The count
  // is honest (cache == actual reviews), so the student-facing reads can't drift (no 84-vs-32).
  const reviewerNames = [
    'Priya Sharma', 'Aarav Menon', 'Diya Kapoor', 'Rohan Gupta', 'Ananya Reddy', 'Kabir Singh',
    'Meera Iyer', 'Vikram Joshi', 'Sara Khan', 'Aditya Rao', 'Nisha Patel', 'Arjun Das',
    'Ishita Bose', 'Dev Malhotra', 'Tara Pillai', 'Karan Mehta',
  ];
  const reviewers = [] as { id: string }[];
  for (const n of reviewerNames) reviewers.push(await createUser(n, null, [Category.music]));

  const reviewPool: readonly (readonly [number, string])[] = [
    [5, 'Amazing teacher, super patient with beginners!'],
    [4, 'Great vibe and well-structured classes.'],
    [5, 'Loved the trial — signed up the same day.'],
    [4, 'Good facilities, a bit far for me but worth it.'],
    [5, 'Best decision — my technique improved fast.'],
    [5, 'Brilliant mentorship, highly recommend.'],
    [4, 'Solid fundamentals and a friendly community.'],
    [3, 'Decent classes, but the room gets crowded.'],
    [5, 'My kid looks forward to it every week.'],
    [4, 'Flexible timings and a warm atmosphere.'],
    [5, 'Top-notch instructors, real progress.'],
    [4, 'Clean space, good value for money.'],
    [3, 'Good teaching; scheduling could improve.'],
    [5, 'Felt welcome from day one.'],
    [4, 'Pushed me to improve without pressure.'],
    [5, 'Worth every rupee — fantastic experience.'],
  ] as const;

  // Varied, realistic per-academy counts (each ≤ the reviewer pool).
  const targetCounts = [14, 12, 9, 7, 11, 6, 13, 10];
  for (let i = 0; i < academies.length; i++) {
    const academy = academies[i];
    const n = Math.min(targetCounts[i % targetCounts.length], reviewers.length);
    for (let j = 0; j < n; j++) {
      const [rating, comment] = reviewPool[(i + j) % reviewPool.length];
      if (j === 0) {
        // one trial-backed review per academy (realistic: a trial led to a review)
        await createReview(reviewers[j].id, academy.id, academy.batches[0], rating, comment, 7 + i * 3);
      } else {
        await prisma.review.create({
          data: { userId: reviewers[j].id, academyId: academy.id, batchId: academy.batches[0].id, source: 'trial', rating, comment },
        });
      }
    }
    // Reconcile the academy's rating + count to the ACTUAL reviews (single source of truth).
    const all = await prisma.review.findMany({ where: { academyId: academy.id }, select: { rating: true } });
    const avg = all.reduce((s, r) => s + r.rating, 0) / all.length;
    await prisma.academy.update({
      where: { id: academy.id },
      data: { rating: Math.round(avg * 10) / 10, ratingCount: all.length },
    });
  }

  // Demo student — log in with phone 9000000001 to see a populated account.
  const demo = await createUser('Varun Mehta', '9000000001', [Category.music, Category.dance, Category.yoga]);

  // saved academies
  await prisma.savedAcademy.createMany({
    data: [
      { userId: demo.id, academyId: academies[0].id },
      { userId: demo.id, academyId: academies[7].id },
    ],
  });

  // an upcoming (booked) trial at the first academy's first batch
  {
    const a = academies[0];
    const b = a.batches[0];
    const booking = await prisma.booking.create({
      data: {
        userId: demo.id, batchId: b.id, slotId: b.slotIds[0],
        status: BookingStatus.confirmed, reservationExpiresAt: atHour(2, 12), paidAt: new Date(),
      },
    });
    await prisma.trial.create({
      data: {
        userId: demo.id, academyId: a.id, batchId: b.id, slotId: b.slotIds[0],
        bookingId: booking.id, trialAt: atHour(2, 10), status: TrialStatus.booked,
      },
    });
  }

  // --- Testable trials at The Rhythm House (academy login 9876500010) ---
  // Booked & scheduled for TODAY so they surface in the academy inbox/schedule and can be
  // "Mark attendance"-ed. Each student has a pinned 4-digit attendance code to enter.
  {
    const a = academies[0];
    const guitar = a.batches[0]; // in-studio (QR/OTP trial)
    const piano = a.batches[1]; // online (Findemy live room)
    const testStudents: { name: string; otp: string; batch: CreatedBatch; hour: number }[] = [
      { name: 'Aarav Sharma', otp: '1234', batch: guitar, hour: 17 },
      { name: 'Riya Kapoor', otp: '5678', batch: piano, hour: 18 },
      { name: 'Ishaan Verma', otp: '4321', batch: guitar, hour: 19 },
    ];
    for (const s of testStudents) {
      const student = await createUser(s.name, null, [Category.music], s.otp);
      await createBookedTrial(student.id, a.id, s.batch, atHour(0, s.hour));
    }
    console.log('Test trials @ The Rhythm House (academy login 9876500010):');
    for (const s of testStudents) {
      const mode = s.batch === piano ? 'online' : 'in-studio';
      console.log(`  • ${s.name} — ${mode} — attendance code ${s.otp}`);
    }
  }

  // an active monthly enrollment at the dance academy (index 2)
  {
    const a = academies[2];
    const b = a.batches[0];
    const enrollment = await prisma.enrollment.create({
      data: { userId: demo.id, batchId: b.id, status: EnrollmentStatus.active, defaultPackage: EnrollmentPackage.monthly },
    });
    const period = await prisma.enrollmentPeriod.create({
      data: {
        enrollmentId: enrollment.id,
        packageType: EnrollmentPackage.monthly,
        startDate: daysFromNow(-10),
        endDate: daysFromNow(20),
        amountPaise: 180000,
        status: EnrollmentPeriodStatus.active,
      },
    });
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { currentPeriodId: period.id } });
  }

  // --- Enrolled students + past attendance for The Rhythm House ---
  // Populates the batch roster (tiers/attendance %) and the Schedule tab's completed-class
  // records. Guitar meets Sat+Sun 10:00 (in-studio); Piano meets Tue+Thu 18:00 (online).
  {
    const rhythm = academies[0];
    const guitar = rhythm.batches[0];
    const piano = rhythm.batches[1];
    const plan = [
      { batch: guitar, dows: [6, 0], hh: 10, mm: 0 },
      { batch: piano, dows: [2, 4], hh: 18, mm: 0 },
    ];
    const rosterNames = ['Ananya Reddy', 'Ishaan Thakur', 'Riya Gupta', 'Karan Malhotra', 'Priya Nair', 'Dev Sharma'];
    let ri = 0;

    for (const p of plan) {
      const enrolledUserIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const u = await createUser(rosterNames[ri % rosterNames.length], `98765${44000 + ri}`, [Category.music]);
        ri++;
        const enr = await prisma.enrollment.create({
          data: { userId: u.id, batchId: p.batch.id, status: EnrollmentStatus.active, defaultPackage: EnrollmentPackage.monthly },
        });
        const period = await prisma.enrollmentPeriod.create({
          data: {
            enrollmentId: enr.id,
            packageType: EnrollmentPackage.monthly,
            startDate: daysFromNow(-20),
            endDate: daysFromNow(10),
            amountPaise: 299900,
            status: EnrollmentPeriodStatus.active,
          },
        });
        await prisma.enrollment.update({ where: { id: enr.id }, data: { currentPeriodId: period.id } });
        enrolledUserIds.push(u.id);
      }

      // Past sessions in the last 2 weeks → present rows (~75% attendance, absentees omitted).
      for (let k = 1; k <= 14; k++) {
        const dateStr = istDateKey(daysFromNow(-k));
        const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
        if (!p.dows.includes(dow)) continue;
        const date = new Date(`${dateStr}T00:00:00.000Z`);
        const markedAt = istWallClockToUtc(dateStr, p.hh, p.mm + 3);
        for (let i = 0; i < enrolledUserIds.length; i++) {
          // Deterministic present/absent mix that varies by day so attendance % differs.
          const present = (i + k) % 4 !== 0;
          if (!present) continue;
          await prisma.batchAttendance.create({
            data: { batchId: p.batch.id, userId: enrolledUserIds[i], date, present: true, markedAt },
          });
        }
      }
    }
  }

  await seedWorkshopsAndEvents(academies);

  const counts = {
    academies: await prisma.academy.count(),
    coaches: await prisma.coach.count(),
    programs: await prisma.program.count(),
    batches: await prisma.batch.count(),
    slots: await prisma.slot.count(),
    workshops: await prisma.workshop.count(),
    events: await prisma.event.count(),
    reviews: await prisma.review.count(),
    users: await prisma.user.count(),
    enrollments: await prisma.enrollment.count(),
  };
  console.log('Seeded:', counts);
  console.log('Demo student login phone: 9000000001 (read the OTP from this API terminal).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
