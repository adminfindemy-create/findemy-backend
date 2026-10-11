import {
  PrismaClient,
  Category,
  BatchMode,
  SessionFormat,
  BatchGender,
  WorkshopType,
  EventMode,
  EventType,
  TrialStatus,
  BookingStatus,
  EnrollmentStatus,
  EnrollmentPackage,
  EnrollmentPeriodStatus,
  OfferedMode,
} from '@prisma/client';
import { istDateKey, istWallClockToUtc } from '../src/lib/ist.js';
import { seedStaffRoles } from './seed-staff-roles.js';
import { selfLearnerCreate } from '../src/lib/learner-access.js';

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
  // Attendance-era tables that hang off Batch. Without these the wipe fails with
  // `class_sessions_batchId_fkey` on any database that has ever recorded a class — which is
  // every database the attendance work has run against.
  await prisma.sessionCredit.deleteMany();
  await prisma.classSession.deleteMany();
  await prisma.sessionReminderSent.deleteMany();
  // `classNoteFile` cascades from `classNote`.
  await prisma.classNote.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.programMedia.deleteMany();
  await prisma.program.deleteMany();
  await prisma.coach.deleteMany();
  await prisma.workshop.deleteMany();
  await prisma.event.deleteMany();
  await prisma.savedAcademy.deleteMany();
  await prisma.expoPushToken.deleteMany();
  await prisma.referral.deleteMany();
  // Settlement/money ledgers reference Academy — clear before deleting academies.
  await prisma.commissionLedger.deleteMany();
  await prisma.reserveHold.deleteMany();
  await prisma.academyRecovery.deleteMany();
  await prisma.payout.deleteMany();
  // Staff logins are per-brand domain data, wiped children-first like everything else.
  // `staffRole` / `staffRolePermission` are deliberately NOT wiped: they are the SHARED system
  // role catalogue owned by seed-staff-roles.ts, and dropping them on every reseed would
  // silently unseed every brand's permissions.
  await prisma.academyGroupSettings.deleteMany();
  await prisma.staffBranchScope.deleteMany();
  await prisma.staffRoleAssignment.deleteMany();
  await prisma.staffAccount.deleteMany();
  await prisma.academyAccount.deleteMany();
  await prisma.academy.deleteMany();
  await prisma.gSTRegistration.deleteMany();
  await prisma.financialEntity.deleteMany();
  await prisma.academyGroup.deleteMany();
  await prisma.guardianship.deleteMany();
  await prisma.user.deleteMany();
  await prisma.learner.deleteMany();
}

type BatchSpec = {
  // Academy-authored label distinguishing sibling batches; `level` is on the program now.
  name: string;
  minAge?: number;
  maxAge?: number;
  sessionFormat?: SessionFormat;
  gender?: BatchGender;
  mode: BatchMode;
  capacity: number;
  trialFeePaise: number;
  monthlyFeePaise: number;
  // S1.3: academy-set discounts in bps (≤3000). Demo values on the featured academy.
  quarterlyDiscountBps?: number;
  annualDiscountBps?: number;
  timings: { dayOfWeek: number; startTime: string; durationMin: number }[];
  // Which BRANCH runs this batch, as an index into the brand's `branches`. Defaults to the
  // primary location. A batch is always owned by exactly one branch — including an online
  // one, whose branch owns the coach, the payout attribution and the reporting line even
  // though its coordinates are ignored for discovery (plan §1.2).
  branchIndex?: number;
};

// An additional physical location of the brand. The first branch is described by the spec's
// own address/lat/lng fields; these are the extra ones.
type BranchSpec = {
  branchLabel: string;
  address: string;
  lat: number;
  lng: number;
  verified: boolean;
  rating: number;
  ratingCount: number;
  // Index into the brand's financial entities. Two branches pointing at the same index share
  // one payee — one KYC record, one bank account, ONE payout row per period.
  financialEntityIndex?: number;
  // Amenities are a property of the BUILDING, so a branch can differ from its brand — a
  // basement studio with no lift, a location with no parking. Falls back to the brand's set.
  amenities?: string[];
};

// A named offering. Owns the identity/marketing copy; holds one or more batches.
type ProgramSpec = {
  title: string;
  level: string;
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
  // The public profile fields a learner reads on the academy page. Seeded because a field the
  // demo data leaves empty is a field nobody notices has stopped being rendered — which is
  // exactly how tagline/specialities/modesOffered went unshown for so long.
  tagline: string;
  specialities: string[];
  // Keys from the AMENITIES catalogue in @findemy/types. Seeded for the same reason as
  // tagline/specialities: an empty column is one nobody notices has stopped rendering.
  amenities: string[];
  modesOffered: OfferedMode[];
  accountPhone: string;
  // The owner's own name, distinct from the brand's.
  ownerName: string;
  // Manager logins for this brand. Omitted for most demo academies — one brand carrying a
  // manager is enough to exercise the role.
  staff?: StaffSpec[];
  // Each coach becomes TWO linked rows: their public teaching profile and their teacher login,
  // under the same name and the same phone. `phone` is their login. A blank `specialty` seeds
  // an invited-but-unfinished profile, which is what the completion prompt is for.
  coaches: { name: string; specialty: string; bio: string; phone: string; credentials?: string }[];
  programs: ProgramSpec[];
  // Label for the PRIMARY location. Null for a single-branch brand, whose display name is
  // just the brand name.
  branchLabel?: string;
  // Extra locations beyond the primary one.
  branches?: BranchSpec[];
  // How many payees this brand has. >1 lets branches settle separately.
  financialEntityLabels?: string[];
};

const t = (dayOfWeek: number, startTime: string, durationMin = 60) => ({
  dayOfWeek,
  startTime,
  durationMin,
});

// A NON-TEACHING login — a manager. Teachers are not listed here: every coach now gets a
// teacher login automatically (see the coaches array), because a coach and a teacher are the
// same person and app access is required for all of them.
type StaffSpec = {
  name: string;
  phone: string;
  role: 'manager';
};

const ACADEMIES: AcademySpec[] = [
  {
    name: 'The Rhythm House',
    category: Category.music,
    address: '12 Hauz Khas Village, New Delhi 110016',
    lat: 28.5494, lng: 77.2001, verified: true, onlineAvailable: true, rating: 4.8, ratingCount: 124,
    bio: 'Guitar, piano, and vocals from working musicians. Graded curriculum, recitals every term.',
    tagline: 'Where practice becomes performance.',
    specialities: ['Guitar', 'Piano', 'Vocals', 'Graded exams'],
    amenities: ['parking', 'ac', 'washroom', 'drinking_water', 'instruments', 'waiting_area', 'cctv', 'wifi'],
    modesOffered: [OfferedMode.in_studio, OfferedMode.online],
    accountPhone: '9876500010',
    ownerName: 'Anil Mehra',
    // The multi-branch demo brand: 3 locations, 2 financial entities, ONE set of programs and
    // coaches shared across all of them, and one online batch. Every path in the multi-branch
    // plan has coverage here.
    branchLabel: 'Hauz Khas',
    financialEntityLabels: ['Rhythm House Pvt Ltd', 'Rhythm House Noida LLP'],
    branches: [
      {
        branchLabel: 'Saket',
        address: 'Saket District Centre, New Delhi 110017',
        lat: 28.5245, lng: 77.2066,
        verified: true, rating: 4.6, ratingCount: 38,
        // Same legal setup as Hauz Khas → they settle together in one payout.
        financialEntityIndex: 0,
        // A smaller room above a market: no parking, no waiting area — which is the point of
        // storing amenities per branch rather than per brand.
        amenities: ['ac', 'washroom', 'drinking_water', 'instruments', 'wifi', 'lift'],
      },
      {
        branchLabel: 'Noida',
        address: 'Sector 18, Noida 201301',
        lat: 28.5708, lng: 77.3260,
        // A brand-new location: approved for discovery but with NO reviews of its own, so the
        // student app shows the group aggregate as labelled copy instead of a fake rating.
        verified: true, rating: 0, ratingCount: 0,
        // A separate legal entity → its own KYC and its own payout row.
        financialEntityIndex: 1,
      },
    ],
    // The RBAC demo brand. Rahul runs the primary branch day to day; Ravi and Anita each log in
    // as themselves and see only their own batches. Everyone here is scoped to Hauz Khas, so the
    // Saket and Noida branches are what proves branch scoping actually excludes something.
    staff: [{ name: 'Rahul Verma', phone: '9876500011', role: 'manager' }],
    coaches: [
      {
        name: 'Ravi Kumar',
        specialty: 'Guitar · 10 yrs',
        bio: 'Trinity College London graduate.',
        credentials: '10 years teaching · Trinity College London, Grade 8 Guitar',
        phone: '9876500110',
      },
      {
        name: 'Anita Desai',
        specialty: 'Piano · 8 yrs',
        bio: 'Classical pianist and examiner.',
        credentials: '8 years teaching · ABRSM examiner',
        phone: '9876500111',
      },
      // Invited but has not filled anything in yet — a blank `specialty` is exactly what a
      // freshly invited teacher looks like, and what the completion prompt exists for. No
      // batches, so students never see the empty profile.
      { name: 'Kabir Sen', specialty: '', bio: '', phone: '9876500112' },
    ],
    programs: [
      {
        title: 'Guitar',
        level: 'Beginner',
        description: 'Learn acoustic and electric guitar from working musicians — chords, technique, and songs you actually want to play.',
        thingsToKnow: ['Bring your own guitar', 'Arrive 10 minutes early', 'All ages welcome'],
        batches: [
          { name: 'Sat/Sun 10:00', minAge: 8, mode: BatchMode.offline, capacity: 8, trialFeePaise: 9900, monthlyFeePaise: 299900, quarterlyDiscountBps: 1000, annualDiscountBps: 2000, timings: [t(6, '10:00'), t(0, '10:00')] },
          // The SAME Guitar program, offered at Saket — authored once, no duplicate program,
          // no duplicate coach. This is the payoff of the restructuring.
          { name: 'Mon/Wed 18:00', minAge: 8, mode: BatchMode.offline, capacity: 10, trialFeePaise: 9900, monthlyFeePaise: 299900, timings: [t(1, '18:00'), t(3, '18:00')], branchIndex: 1 },
        ],
      },
      {
        title: 'Piano',
        level: 'Intermediate',
        description: 'Graded piano lessons from a classical examiner — sight-reading, theory, and performance, online.',
        thingsToKnow: ['A weighted keyboard or piano at home is recommended', 'Live online sessions'],
        batches: [
          // Online batch owned by the Noida branch: its coordinates are ignored for discovery,
          // but the branch still owns the coach, the payout attribution and the reporting line.
          { name: 'Tue/Thu 18:00', sessionFormat: SessionFormat.one_on_one, mode: BatchMode.online, capacity: 6, trialFeePaise: 0, monthlyFeePaise: 349900, quarterlyDiscountBps: 1000, annualDiscountBps: 2000, timings: [t(2, '18:00'), t(4, '18:00')], branchIndex: 2 },
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
    tagline: 'The guru-shishya tradition, kept alive.',
    specialities: ['Hindustani vocals', 'Tabla', 'Classical theory'],
    amenities: ['washroom', 'drinking_water', 'instruments', 'waiting_area', 'ac'],
    modesOffered: [OfferedMode.in_studio],
    accountPhone: '9876500020',
    ownerName: 'Sunita Rao',
    coaches: [{ name: 'Pandit Sharma', specialty: 'Hindustani Vocals · 20 yrs', bio: 'Performing artist for two decades.', phone: '9876500120' }],
    programs: [
      {
        title: 'Hindustani Vocals',
        level: 'Beginner',
        description: 'Classical Hindustani vocal training in a traditional guru-shishya setting — ragas, taals, and breath control.',
        thingsToKnow: ['Morning classes', 'No prior experience needed'],
        batches: [
          { name: 'Sat/Sun 08:00', mode: BatchMode.offline, capacity: 10, trialFeePaise: 5000, monthlyFeePaise: 250000, timings: [t(6, '08:00'), t(0, '08:00')] },
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
    tagline: 'Discipline first. Expression always.',
    specialities: ['Bharatanatyam', 'Bollywood', 'Contemporary'],
    amenities: ['parking', 'ac', 'washroom', 'changing_room', 'mirrored_studio', 'drinking_water', 'lockers', 'waiting_area'],
    modesOffered: [OfferedMode.in_studio, OfferedMode.home_visit],
    accountPhone: '9876500030',
    ownerName: 'Deepak Nair',
    coaches: [{ name: 'Meera Iyer', specialty: 'Bharatanatyam · 14 yrs', bio: 'Performed across India; 200+ students.', phone: '9876500130' }],
    programs: [
      {
        title: 'Bharatanatyam',
        level: 'Beginner',
        description: 'Classical Bharatanatyam with disciplined foundations — adavus, mudras, and expressive abhinaya.',
        thingsToKnow: ['Wear comfortable practice clothes', 'Barefoot practice'],
        batches: [
          { name: 'Sat/Sun 17:00', minAge: 5, maxAge: 14, mode: BatchMode.offline, capacity: 12, trialFeePaise: 10000, monthlyFeePaise: 180000, timings: [t(6, '17:00'), t(0, '17:00')] },
        ],
      },
      {
        title: 'Bollywood',
        level: 'All levels',
        description: 'High-energy Bollywood choreography for all levels — learn a new routine every few weeks.',
        thingsToKnow: ['All levels welcome', 'Comfortable shoes recommended'],
        batches: [
          { name: 'Fri 19:00', mode: BatchMode.offline, capacity: 15, trialFeePaise: 0, monthlyFeePaise: 160000, timings: [t(5, '19:00')] },
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
    tagline: 'Built in the cypher.',
    specialities: ['Hip-hop', 'Street', 'Battles'],
    amenities: ['ac', 'washroom', 'changing_room', 'mirrored_studio', 'lockers', 'wifi', 'lift'],
    modesOffered: [OfferedMode.in_studio],
    accountPhone: '9876500040',
    ownerName: 'Farah Khan',
    coaches: [{ name: 'Karan Mehta', specialty: 'Hip-Hop · 9 yrs', bio: 'Choreographer and battle judge.', phone: '9876500140' }],
    programs: [
      {
        title: 'Hip-Hop',
        level: 'Beginner',
        description: 'Street and hip-hop foundations — grooves, isolations, and choreography, building toward battles and showcases.',
        thingsToKnow: ['Wear sneakers', 'Come warmed up'],
        batches: [
          { name: 'Mon/Wed 19:30', mode: BatchMode.offline, capacity: 16, trialFeePaise: 7500, monthlyFeePaise: 200000, timings: [t(1, '19:30'), t(3, '19:30')] },
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
    tagline: 'Learn to see, then to draw.',
    specialities: ['Sketching', 'Watercolour', 'Portraiture'],
    amenities: ['ac', 'washroom', 'drinking_water', 'waiting_area', 'wifi'],
    modesOffered: [OfferedMode.in_studio, OfferedMode.online],
    accountPhone: '9876500050',
    ownerName: 'Vikram Shah',
    coaches: [{ name: 'Arjun Rao', specialty: 'Watercolour · 8 yrs', bio: 'Fine-arts graduate and exhibiting artist.', phone: '9876500150' }],
    programs: [
      {
        title: 'Watercolour',
        level: 'Beginner',
        description: 'Watercolour painting for all ages — washes, colour theory, and composition with an exhibiting artist.',
        thingsToKnow: ['Materials provided for the first class', 'Aprons recommended'],
        batches: [
          { name: 'Sat 11:00', mode: BatchMode.offline, capacity: 12, trialFeePaise: 0, monthlyFeePaise: 250000, timings: [t(6, '11:00', 90)] },
        ],
      },
      {
        title: 'Sketching',
        level: 'Beginner',
        description: 'Pencil and ink sketching fundamentals delivered live online — line, form, light, and shade.',
        thingsToKnow: ['Bring a sketchbook and pencils', 'Live online sessions'],
        batches: [
          { name: 'Sun 16:00', mode: BatchMode.online, capacity: 20, trialFeePaise: 0, monthlyFeePaise: 150000, timings: [t(0, '16:00', 90)] },
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
    tagline: 'Clay, glaze, patience.',
    specialities: ['Wheel throwing', 'Hand building', 'Glazing'],
    amenities: ['parking', 'washroom', 'drinking_water', 'changing_room', 'first_aid'],
    modesOffered: [OfferedMode.in_studio],
    accountPhone: '9876500060',
    ownerName: 'Neha Bansal',
    coaches: [{ name: 'Sneha Pillai', specialty: 'Pottery · 6 yrs', bio: 'Studio potter and ceramicist.', phone: '9876500160' }],
    programs: [
      {
        title: 'Pottery',
        level: 'Beginner',
        description: 'Hand-building and wheel-throwing for hobbyists and serious makers — weekend studio sessions.',
        thingsToKnow: ['Clay and tools provided', 'Wear clothes you can get messy'],
        batches: [
          { name: 'Sat 15:00', mode: BatchMode.offline, capacity: 8, trialFeePaise: 15000, monthlyFeePaise: 320000, timings: [t(6, '15:00', 120)] },
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
    tagline: 'Breath before posture.',
    specialities: ['Hatha', 'Vinyasa', 'Pranayama'],
    amenities: ['parking', 'ac', 'washroom', 'changing_room', 'drinking_water', 'lockers', 'mirrored_studio', 'wheelchair'],
    modesOffered: [OfferedMode.in_studio, OfferedMode.online, OfferedMode.home_visit],
    accountPhone: '9876500070',
    ownerName: 'Rakesh Menon',
    coaches: [{ name: 'Lakshmi Nair', specialty: 'Hatha Yoga · 12 yrs', bio: 'Certified instructor, decade of teaching.', phone: '9876500170' }],
    programs: [
      {
        title: 'Hatha Yoga',
        level: 'All levels',
        description: 'Hatha and Ashtanga yoga for all levels — asanas, alignment, and breath, dawn and dusk.',
        thingsToKnow: ['Bring your own mat', 'Practice on an empty stomach'],
        batches: [
          { name: 'Mon/Wed/Fri 06:30', gender: BatchGender.female_only, mode: BatchMode.offline, capacity: 20, trialFeePaise: 0, monthlyFeePaise: 150000, timings: [t(1, '06:30'), t(3, '06:30'), t(5, '06:30')] },
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
    tagline: 'Stillness, taught slowly.',
    specialities: ['Meditation', 'Breathwork', 'Restorative yoga'],
    amenities: ['washroom', 'drinking_water', 'changing_room', 'waiting_area', 'lift', 'wheelchair'],
    modesOffered: [OfferedMode.online, OfferedMode.home_visit],
    accountPhone: '9876500080',
    ownerName: 'Shalini Gupta',
    coaches: [{ name: 'Dev Anand', specialty: 'Vinyasa · 11 yrs', bio: 'RYT-500, breathwork facilitator.', phone: '9876500180' }],
    programs: [
      {
        title: 'Vinyasa Flow',
        level: 'Intermediate',
        description: 'Vinyasa flow, breathwork, and meditation in small heated online sessions — build strength and focus.',
        thingsToKnow: ['Bring a mat and water', 'Live online sessions'],
        batches: [
          { name: 'Tue/Thu/Sat 07:00', mode: BatchMode.online, capacity: 25, trialFeePaise: 0, monthlyFeePaise: 180000, timings: [t(2, '07:00'), t(4, '07:00'), t(6, '08:00')] },
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

    // --- The BRAND ---
    const group = await prisma.academyGroup.create({
      data: {
        name: spec.name,
        category: spec.category,
        bio: spec.bio,
      },
    });

    // --- The PAYEE(S) ---
    // `status` is authoritative; `verified` mirrors (status == approved). A verified brand is
    // seeded with bank KYC done so payouts can fire; an unverified one sits unverified WITH
    // bank details on file so the Ops Console KYC flow can create a RazorpayX FundAccount.
    // Note this is per ENTITY now, not per branch — the whole point of the split.
    const entityLabels = spec.financialEntityLabels ?? [spec.name];
    const entities = [];
    for (let ei = 0; ei < entityLabels.length; ei++) {
      entities.push(
        await prisma.financialEntity.create({
          data: {
            groupId: group.id,
            label: entityLabels[ei],
            bankKycStatus: spec.verified ? 'verified' : 'unverified',
            rzpContactId: spec.verified ? `cont_mock_seed_${spec.category}_${idx}_${ei}` : null,
            rzpFundAccountId: spec.verified ? `fa_mock_seed_${spec.category}_${idx}_${ei}` : null,
            bankAccountNumber: '000111222333',
            bankIfsc: 'HDFC0000001',
            bankHolderName: entityLabels[ei],
            gstRegistrations: {
              create: [{ gstNumber: `07AAACR${1000 + idx}${ei}Z5`, state: 'Delhi' }],
            },
          },
        }),
      );
    }

    // --- The BRANCHES ---
    // `Academy.name` keeps its meaning: the full composed display name. `branchLabel` carries
    // the location on its own, so a card can read "Rhythm House — Saket".
    const branchSpecs = [
      {
        branchLabel: spec.branchLabel,
        address: spec.address,
        lat: spec.lat,
        lng: spec.lng,
        verified: spec.verified,
        rating: spec.rating,
        ratingCount: spec.ratingCount,
        financialEntityIndex: 0,
        // The primary location has no override of its own — it IS the brand's building.
        // Carried explicitly so this literal and BranchSpec share a shape (see the read below).
        amenities: spec.amenities,
      },
      ...(spec.branches ?? []),
    ];

    const branches = [];
    for (const bs of branchSpecs) {
      branches.push(
        await prisma.academy.create({
          data: {
            groupId: group.id,
            financialEntityId: entities[bs.financialEntityIndex ?? 0].id,
            branchLabel: bs.branchLabel ?? null,
            name: bs.branchLabel ? `${spec.name} — ${bs.branchLabel}` : spec.name,
            category: spec.category,
            address: bs.address,
            lat: bs.lat,
            lng: bs.lng,
            verified: bs.verified,
            status: bs.verified ? 'approved' : 'pending_review',
            onlineAvailable: spec.onlineAvailable,
            rating: bs.rating,
            ratingCount: bs.ratingCount,
            bio: spec.bio,
            tagline: spec.tagline,
            specialities: spec.specialities,
            amenities: bs.amenities ?? spec.amenities,
            modesOffered: spec.modesOffered,
            images,
          },
        }),
      );
    }
    const academy = branches[0];

    // BRAND settings: the public contact details and privacy flag. Keyed on the group, not on a
    // login — stored per-login, the contact number a LEARNER sees would depend on which staff
    // member saved last. The migration backfills existing brands; a brand created after it (a
    // reseed, or a real signup) needs its row made here.
    await prisma.academyGroupSettings.create({
      data: { groupId: group.id, privacyShowPhone: false },
    });

    // ONE login for the whole brand, landing on the primary branch. The account is linked to
    // the GROUP — `groupId` is intentionally non-unique so branch-manager logins can be added
    // later without migrating this table twice.
    await prisma.academyAccount.create({
      data: {
        phone: spec.accountPhone,
        groupId: group.id,
        defaultAcademyId: academy.id,
        // The PERSON behind the brand. Left null before, so the owner was the one role whose
        // own account screen showed no name at all.
        ownerName: spec.ownerName,
      },
    });

    const systemRole = async (key: 'manager' | 'teacher') => {
      const role = await prisma.staffRole.findFirst({
        where: { key, groupId: null, isSystem: true },
        select: { id: true },
      });
      if (!role) throw new Error(`seed: system role '${key}' missing — run seedStaffRoles first`);
      return role.id;
    };

    // Coaches are BRAND-level: Ravi is one row who teaches at whichever branches his batches
    // run at, not a duplicate row per location.
    //
    // Each coach gets a TEACHER LOGIN in the same breath, under the same name and phone —
    // because a coach and a teacher are one person, and app access is required for all of them.
    // This mirrors exactly what `inviteStaff` does in the app, so the demo data and the real
    // flow cannot describe different worlds.
    const teacherRoleId = await systemRole('teacher');
    const coaches = [];
    for (const c of spec.coaches) {
      const coach = await prisma.coach.create({
        data: {
          groupId: group.id,
          name: c.name,
          specialty: c.specialty,
          bio: c.bio,
          credentials: c.credentials,
          homeBranchId: academy.id,
        },
      });
      coaches.push(coach);

      const login = await prisma.staffAccount.create({
        data: {
          groupId: group.id,
          phone: c.phone,
          name: c.name,
          // Seeded already-redeemed so the slices are testable without going through an invite.
          status: 'active',
          activatedAt: new Date(),
        },
      });
      await prisma.staffRoleAssignment.create({
        data: {
          staffId: login.id,
          roleId: teacherRoleId,
          coachId: coach.id,
          // Scoped to the PRIMARY branch only. The brand's other branches are what a
          // branch-scope test has to be denied.
          branches: { create: [{ academyId: academy.id }] },
        },
      });
    }

    // Managers — logins that carry no teaching profile.
    for (const st of spec.staff ?? []) {
      const roleId = await systemRole(st.role);
      const staff = await prisma.staffAccount.create({
        data: {
          groupId: group.id,
          phone: st.phone,
          name: st.name,
          status: 'active',
          activatedAt: new Date(),
        },
      });
      await prisma.staffRoleAssignment.create({
        data: {
          staffId: staff.id,
          roleId,
          coachId: null,
          branches: { create: [{ academyId: academy.id }] },
        },
      });
    }

    // Programs are BRAND-level too — authored once. Which branches offer a program is DERIVED
    // from where its batches run, never stored (plan §1.1).
    // `batches` stays flattened (program order, then batch order) so downstream seed code
    // that indexes academy.batches[0]/[1] is unchanged. Coach assignment uses the flat index.
    const batches: CreatedBatch[] = [];
    let batchIdx = 0;
    for (const p of spec.programs) {
      const photos = PROGRAM_PHOTOS[spec.category] ?? [];
      const program = await prisma.program.create({
        data: {
          groupId: group.id,
          title: p.title,
          category: spec.category,
          level: p.level,
          description: p.description,
          thingsToKnow: p.thingsToKnow ?? [],
          media: {
            create: photos.map((id, i) => ({ url: coverUrl(id), type: 'photo', order: i })),
          },
        },
      });
      for (const b of p.batches) {
        // Round-robin over the coaches who have actually set themselves up. A teacher whose
        // profile is still blank has only just been invited — giving them a class would also
        // put an empty profile on the student-facing academy page.
        const teaching = coaches.filter((c) => c.specialty.trim().length > 0);
        const pool = teaching.length > 0 ? teaching : coaches;
        const coach = pool[batchIdx % pool.length];
        batchIdx++;
        // The branch that OPERATES this batch. `Batch.academyId` is unchanged in meaning.
        const branch = branches[b.branchIndex ?? 0] ?? branches[0];
        const batch = await prisma.batch.create({
          data: {
            academyId: branch.id,
            programId: program.id,
            coachId: coach.id,
            // Denormalized from the program until the contract slice (see schema note).
            title: `${p.title} · ${b.name}`,
            category: spec.category,
            name: b.name,
            ...(b.minAge !== undefined ? { minAge: b.minAge } : {}),
            ...(b.maxAge !== undefined ? { maxAge: b.maxAge } : {}),
            ...(b.sessionFormat ? { sessionFormat: b.sessionFormat } : {}),
            ...(b.gender ? { gender: b.gender } : {}),
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
        for (let sl = 0; sl < 3; sl++) {
          const slot = await prisma.slot.create({
            data: { batchId: batch.id, slotTime: atHour(2 + sl * 2, 10), capacity: b.capacity, reservedCount: 1 },
          });
          slotIds.push(slot.id);
        }
        batches.push({ id: batch.id, academyId: branch.id, slotIds });
      }
    }

    // A teacher's branch scope should be WHERE THEY ACTUALLY TEACH. Batches are created after
    // the logins, so the scope is corrected here rather than guessed earlier — otherwise a
    // coach whose class runs at Noida, scoped to the primary branch, cannot see their own
    // batch: branch scope and coach scope intersect, and the intersection would be empty.
    for (const coach of coaches) {
      const assignment = await prisma.staffRoleAssignment.findFirst({
        where: { coachId: coach.id },
        select: { id: true },
      });
      if (!assignment) continue;
      const taughtAt = await prisma.batch.findMany({
        where: { coachId: coach.id },
        select: { academyId: true },
        distinct: ['academyId'],
      });
      // A teacher with no batches yet keeps the primary branch, so they still land somewhere.
      const branchIds = taughtAt.length ? taughtAt.map((b) => b.academyId) : [academy.id];
      await prisma.staffBranchScope.deleteMany({ where: { assignmentId: assignment.id } });
      await prisma.staffBranchScope.createMany({
        data: branchIds.map((academyId) => ({ assignmentId: assignment.id, academyId })),
      });
    }

    academies.push({ id: academy.id, name: spec.name, category: spec.category, batches });
  }

  return academies;
}

/** A seeded user's own learner — every row about attending is keyed on it. */
async function learnerOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { selfLearnerId: true } });
  return u.selfLearnerId!;
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
      ...selfLearnerCreate({
        name,
        avatarInitial: name.slice(0, 2).toUpperCase(),
        attendanceOtp: otp ?? (userSeq === 1 ? '4927' : String(1000 + userSeq).slice(0, 4)),
      }),
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
      learnerId: await learnerOf(userId),
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
      learnerId: await learnerOf(userId),
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
      learnerId: await learnerOf(userId),
      batchId: batch.id,
      status: BookingStatus.confirmed,
      trialAt,
      reservationExpiresAt: trialAt,
      paidAt: new Date(),
    },
  });
  await prisma.trial.create({
    data: { userId, learnerId: await learnerOf(userId), academyId, batchId: batch.id, bookingId: booking.id, trialAt, status: TrialStatus.booked },
  });
}

async function seedWorkshopsAndEvents(academies: { id: string; name: string; category: Category }[]) {
  const byCat = (c: Category) => academies.find((a) => a.category === c)!;

  // Photo ids are the ones already credited in ai-usage/prototypes/assets/CREDITS.txt, so the
  // seed reuses known-good Unsplash images rather than inventing urls. Wider than the card
  // thumbnails (w=1200) because the same cover fills the detail hero.
  const cover = (id: string) => `https://images.unsplash.com/photo-${id}?w=1200&q=80&auto=format&fit=crop`;

  const workshops: {
    academyId: string; type: WorkshopType; title: string; category: Category; description: string;
    startAt: Date; durationMin: number; location: string | null; capacity: number; registeredCount: number; pricePaise: number;
    coverImageUrl: string | null;
  }[] = [
    { academyId: byCat(Category.music).id, category: Category.music, type: WorkshopType.offline, title: 'Fingerstyle Guitar Masterclass', description: 'A 2-hour deep dive into fingerstyle technique and arrangement.', startAt: atHour(6, 17), durationMin: 120, location: 'Hauz Khas, New Delhi', capacity: 30, registeredCount: 18, pricePaise: 39900, coverImageUrl: cover('1510915361894-db8b60106cb1') },
    { academyId: byCat(Category.music).id, category: Category.music, type: WorkshopType.online, title: 'Music Theory Crash Course', description: 'Scales, chords, and progressions for beginners — live online.', startAt: atHour(9, 19), durationMin: 90, location: null, capacity: 100, registeredCount: 54, pricePaise: 19900, coverImageUrl: cover('1520523839897-bd0b52f945a0') },
    { academyId: byCat(Category.dance).id, category: Category.dance, type: WorkshopType.offline, title: 'Bollywood Dance Demo Session', description: 'Free taster session — learn a routine in 60 minutes.', startAt: atHour(4, 18), durationMin: 60, location: 'Saket, New Delhi', capacity: 25, registeredCount: 25, pricePaise: 0, coverImageUrl: cover('1547153760-18fc86324498') },
    { academyId: byCat(Category.arts).id, category: Category.arts, type: WorkshopType.offline, title: 'Urban Sketching Walk', description: 'Sketch the city — bring a notebook, we provide the rest.', startAt: atHour(7, 9), durationMin: 180, location: 'Lodhi Garden, New Delhi', capacity: 15, registeredCount: 9, pricePaise: 29900, coverImageUrl: cover('1513364776144-60967b0f800f') },
    { academyId: byCat(Category.yoga).id, category: Category.yoga, type: WorkshopType.offline, title: 'Breathwork & Meditation Intensive', description: 'Pranayama techniques for stress and focus.', startAt: atHour(11, 7), durationMin: 90, location: 'Green Park, New Delhi', capacity: 20, registeredCount: 12, pricePaise: 24900, coverImageUrl: cover('1545205597-3d9d02c29597') },
    { academyId: byCat(Category.yoga).id, category: Category.yoga, type: WorkshopType.online, title: 'Morning Vinyasa Flow (Live)', description: 'Start your weekend with a guided flow, all levels.', startAt: atHour(8, 8), durationMin: 60, location: null, capacity: 80, registeredCount: 41, pricePaise: 14900, coverImageUrl: null },
  ];
  const createdWorkshops = [];
  // `endAt` is derived here exactly as workshops/repo.ts derives it on every API write. The seed
  // is the one write path that does not go through that repo, so it states the rule rather than
  // inheriting it — a seeded workshop with a wrong end time would be invisible to discovery.
  for (const w of workshops) {
    createdWorkshops.push(
      await prisma.workshop.create({
        data: { ...w, endAt: new Date(w.startAt.getTime() + w.durationMin * 60_000) },
      }),
    );
  }

  // Assign teachers to the music brand's workshops so a teacher login has something in their
  // own list — and deliberately leave the OTHER brands' workshops unassigned, which is the
  // owner-runs-it case where students see the owner's name instead.
  const musicCoaches = await prisma.coach.findMany({
    where: { group: { branches: { some: { id: byCat(Category.music).id } } } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, specialty: true },
  });
  const teaching = musicCoaches.filter((c) => c.specialty.trim().length > 0);
  const musicWs = createdWorkshops.filter((w) => w.academyId === byCat(Category.music).id);
  for (let i = 0; i < musicWs.length && teaching.length; i++) {
    // The online one gets TWO co-hosts, so the multi-teacher case is exercised.
    const assigned =
      musicWs[i].type === WorkshopType.online ? teaching.slice(0, 2) : [teaching[i % teaching.length]];
    await prisma.workshopCoach.createMany({
      data: assigned.map((c) => ({ workshopId: musicWs[i].id, coachId: c.id })),
      skipDuplicates: true,
    });
  }

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

  // `mode` is explicit on every row now that Event has the column: an online event had been
  // identified only by the word "Online" in its free-text `location`.
  const events = [
    { type: EventType.competition, mode: EventMode.offline, title: 'Delhi Dance Battle', category: [Category.dance], description: '1v1 hip-hop battles across age categories. Bring your crew; judged by a panel of choreographers. Cash prizes for winners.', startAt: atHour(12, 16), endAt: atHour(12, 21), location: 'Dwarka, New Delhi', lat: 28.5921, lng: 77.0460, capacity: 64, enrolledCount: 48, pricePaise: 29900, organizerName: 'Findemy', coverColor: '#D8492A', registrationDeadline: atHour(10, 23), isSpotlight: true, prizePaise: 5000000, divisions: ['Sub-junior (8–12)', 'Junior (13–17)', 'Open (18+)'] },
    // Online and nationwide, but seeded from the Delhi-NCR launch market — it used to carry
    // lat 12.9716 / lng 77.5946, i.e. Bengaluru, left over from the pre-NCR seed data
    // (flagged in ai-usage/CLAUDE.md §2 and web_phase3_plan.md §7).
    { type: EventType.competition, mode: EventMode.online, title: 'Findemy Utsav — Season 1', category: [Category.music, Category.dance, Category.arts, Category.yoga], description: 'A nationwide showcase across music, dance, arts and yoga.', startAt: atHour(16, 10), endAt: atHour(18, 18), location: 'All India · Online', lat: 28.6139, lng: 77.2090, capacity: 500, enrolledCount: 213, pricePaise: 0, organizerName: 'Findemy', coverColor: '#1A1614', registrationDeadline: atHour(14, 23), isSpotlight: true, prizePaise: 10000000, divisions: ['Solo', 'Group'] },
    { type: EventType.meetup, mode: EventMode.offline, title: 'Weekend Music Jam', category: [Category.music], description: 'A relaxed jam session for beginners and pros alike.', startAt: atHour(7, 18), endAt: atHour(7, 20), location: 'Hauz Khas, New Delhi', lat: 28.5494, lng: 77.2001, capacity: 30, enrolledCount: 17, pricePaise: 0, organizerName: 'The Rhythm House', coverColor: '#1E5C5A', registrationDeadline: atHour(6, 23), isSpotlight: true },
    { type: EventType.workshop, mode: EventMode.offline, title: 'Watercolour Basics Workshop', category: [Category.arts], description: 'A hands-on intro to watercolour techniques for absolute beginners.', startAt: atHour(5, 15), endAt: atHour(5, 18), location: 'Green Park, New Delhi', lat: 28.5583, lng: 77.2065, capacity: 20, enrolledCount: 8, pricePaise: 40000, organizerName: 'Kalapatra Studio', coverColor: '#5B2F3D', registrationDeadline: atHour(4, 23) },
  ];
  for (const e of events) await prisma.event.create({ data: e });
}

async function main() {
  await wipe();
  // The system role catalogue is shared across brands and survives `wipe()`, but it must exist
  // before seedCatalog() creates staff assignments against it. Idempotent.
  await seedStaffRoles(prisma);
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
          data: {
            userId: reviewers[j].id,
            academyId: academy.id,
            batchId: academy.batches[0].id,
            source: 'trial',
            rating,
            comment,
            // Every third review carries the academy's reply, so the "Response from …" block on
            // the student's review card has data behind it. Seeded for the same reason as the
            // profile fields above: an unexercised surface is one nobody notices going missing.
            ...(j % 3 === 0
              ? {
                  response: 'Thank you for the kind words — see you in class!',
                  respondedAt: new Date(),
                }
              : {}),
          },
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

  // SIBLING BRANCHES. `seedCatalog` returns one row per BRAND (`branches[0]`), so the loop above
  // never reached the other locations — while the branch specs above hand them a rating and a
  // ratingCount outright. The Rhythm House — Saket therefore shipped as "4.6 · 38 reviews" with
  // zero review rows behind it: exactly the 84-vs-32 drift this block's own comment promises
  // cannot happen. Every branch is reconciled to its real rows here.
  //
  // A branch seeded at ratingCount 0 is left empty ON PURPOSE — that is the "New location" case
  // the group-rating copy exists for (see the Noida spec), and it must stay demonstrable.
  const primaryIds = new Set(academies.map((a) => a.id));
  const siblingBranches = await prisma.academy.findMany({
    where: { id: { notIn: [...primaryIds] } },
    select: { id: true, ratingCount: true, batches: { select: { id: true }, take: 1 } },
  });

  for (const [i, branch] of siblingBranches.entries()) {
    const batch = branch.batches[0];
    // Reviews require a batch, and one review per (user, academy) caps this at the reviewer pool.
    const want = branch.ratingCount > 0 && batch ? Math.min(branch.ratingCount, reviewers.length) : 0;

    for (let j = 0; j < want; j++) {
      const [rating, comment] = reviewPool[(i + j) % reviewPool.length];
      await prisma.review.create({
        data: {
          userId: reviewers[j].id,
          academyId: branch.id,
          batchId: batch.id,
          source: 'trial',
          rating,
          comment,
          ...(j % 3 === 0
            ? { response: 'Thank you for the kind words — see you in class!', respondedAt: new Date() }
            : {}),
        },
      });
    }

    const all = await prisma.review.findMany({ where: { academyId: branch.id }, select: { rating: true } });
    const avg = all.length ? all.reduce((s, r) => s + r.rating, 0) / all.length : 0;
    await prisma.academy.update({
      where: { id: branch.id },
      data: { rating: all.length ? Math.round(avg * 10) / 10 : 0, ratingCount: all.length },
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
        userId: demo.id, learnerId: await learnerOf(demo.id), batchId: b.id, slotId: b.slotIds[0],
        status: BookingStatus.confirmed, reservationExpiresAt: atHour(2, 12), paidAt: new Date(),
      },
    });
    await prisma.trial.create({
      data: {
        userId: demo.id, learnerId: await learnerOf(demo.id), academyId: a.id, batchId: b.id, slotId: b.slotIds[0],
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
      data: { userId: demo.id, learnerId: await learnerOf(demo.id), batchId: b.id, status: EnrollmentStatus.active, defaultPackage: EnrollmentPackage.monthly },
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
          data: { userId: u.id, learnerId: await learnerOf(u.id), batchId: p.batch.id, status: EnrollmentStatus.active, defaultPackage: EnrollmentPackage.monthly },
        });
        // Every renewal state, one per roster slot — the Fees-due screen has four states and a
        // seed where all nine students are comfortably paid up exercises exactly none of them.
        const DUE_STATES = [
          // overdue: the paid period is gone and grace ran out
          { start: -50, end: -12, status: EnrollmentPeriodStatus.expired, grace: -5, reminders: 3 },
          // grace: ended, still inside the grace window
          { start: -40, end: -4, status: EnrollmentPeriodStatus.grace, grace: 3, reminders: 3 },
          // due_soon: still active, inside DUES_SOON_DAYS
          { start: -27, end: 3, status: EnrollmentPeriodStatus.active, grace: null, reminders: 1 },
          // ok: nothing owed — so the screen's "Nothing outstanding" path is reachable too
          { start: -20, end: 10, status: EnrollmentPeriodStatus.active, grace: null, reminders: 0 },
        ] as const;
        const ds = DUE_STATES[i % DUE_STATES.length];
        const period = await prisma.enrollmentPeriod.create({
          data: {
            enrollmentId: enr.id,
            packageType: EnrollmentPackage.monthly,
            startDate: daysFromNow(ds.start),
            endDate: daysFromNow(ds.end),
            amountPaise: 299900,
            status: ds.status,
            gracePeriodEnd: ds.grace === null ? null : daysFromNow(ds.grace),
            remindersSentCount: ds.reminders,
            lastReminderSentAt: ds.reminders > 0 ? daysFromNow(-2) : null,
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
            data: { batchId: p.batch.id, userId: enrolledUserIds[i], learnerId: await learnerOf(enrolledUserIds[i]), date, present: true, markedAt },
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
