import type { FastifyRequest } from 'fastify';

const now = new Date();
const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);
const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const pastDate = past.toISOString().slice(0, 10);
const nowMonth = now.toISOString().slice(0, 7);

export const fixtures = {
  user: {
    id: '01HX0000000000000000000001',
    phone: '+919845047291',
    name: 'Priya Sharma',
    age: 24,
    location: 'New Delhi',
    lat: 28.5494,
    lng: 77.2001,
    interests: ['music', 'dance', 'yoga'],
    avatarInitial: 'PS',
    attendanceOtp: '4927',
    createdAt: past.toISOString(),
    lastActiveAt: now.toISOString(),
  },
  academyAccount: {
    id: '01HX00000000000000000000A1',
    phone: '+919876543211',
    // The BRAND the login belongs to. `academy_id` below is the landing BRANCH.
    group_id: '01HX00000000000000000000G1',
    academy_id: '01HX00000000000000000000AC1',
    default_academy_id: '01HX00000000000000000000AC1',
    createdAt: past.toISOString(),
  },
  // A second location, so mock mode exercises the branch switcher and the group-scoped
  // inboxes instead of looking like a single-academy world.
  academyBranch2: {
    id: '01HX00000000000000000000AC2',
    name: 'The Rhythm House — Saket',
    branch_label: 'Saket',
    category: 'music',
    address: 'Saket, New Delhi',
    lat: 28.5245,
    lng: 77.2066,
    rating: 4.6,
    verified: true,
    status: 'approved',
    createdAt: past.toISOString(),
  },
  academy: {
    id: '01HX00000000000000000000AC1',
    name: 'The Rhythm House',
    category: 'music',
    address: 'Hauz Khas, New Delhi',
    lat: 28.5494,
    lng: 77.2001,
    verified: true,
    onlineAvailable: true,
    rating: 4.9,
    ratingCount: 84,
    review_count: 84,
    bio: 'Hindustani vocals, guitar, and tabla — graded curriculum trained at Trinity College London.',
    bankAccountId: null,
    createdAt: past.toISOString(),
  },
  coach: {
    id: '01HX00000000000000000000C1',
    academyId: '01HX00000000000000000000AC1',
    name: 'Anand R',
    specialty: 'Guitar · 12 yrs',
    bio: 'Trained at Trinity College London. Has taught 340+ students over the last decade.',
    phone: '+919876543212',
    createdAt: past.toISOString(),
  },
  batch: {
    id: '01HX00000000000000000000B1',
    academyId: '01HX00000000000000000000AC1',
    coachId: '01HX00000000000000000000C1',
    title: 'Guitar · Weekday Evening',
    category: 'music',
    // `level` lives on the program now; the batch carries its own name + attributes.
    name: 'Weekday Evening',
    minAge: 8,
    maxAge: null,
    sessionFormat: 'group',
    gender: 'anyone',
    level: 'Beginner', // program level, mirrored here for the mock program mapper
    capacity: 8,
    trialFeePaise: 15000,
    monthlyFeePaise: 220000,
    status: 'active',
    createdAt: past.toISOString(),
  },
  slot: {
    id: '01HX00000000000000000000S1',
    batchId: '01HX00000000000000000000B1',
    slotTime: future.toISOString(),
    capacity: 8,
    reservedCount: 1,
    status: 'open',
    createdAt: past.toISOString(),
  },
  booking: {
    id: '01HX00000000000000000000BK1',
    userId: '01HX0000000000000000000001',
    batchId: '01HX00000000000000000000B1',
    slotId: '01HX00000000000000000000S1',
    status: 'confirmed',
    rescheduleCount: 0,
    reservationExpiresAt: future.toISOString(),
    createdAt: past.toISOString(),
    paidAt: past.toISOString(),
    cancelledAt: null,
  },
  trial: {
    id: '01HX00000000000000000000T1',
    userId: '01HX0000000000000000000001',
    academyId: '01HX00000000000000000000AC1',
    batchId: '01HX00000000000000000000B1',
    slotId: '01HX00000000000000000000S1',
    bookingId: '01HX00000000000000000000BK1',
    trialAt: future.toISOString(),
    status: 'booked',
    attendanceMarkedAt: null,
    attendanceMarkedByAccountId: null,
    createdAt: past.toISOString(),
  },
  review: {
    id: '01HX00000000000000000000R1',
    userId: '01HX0000000000000000000001',
    academyId: '01HX00000000000000000000AC1',
    batchId: '01HX00000000000000000000B1',
    trialId: '01HX00000000000000000000T1',
    rating: 5,
    comment: 'Amazing experience! Will definitely enroll.',
    response: null,
    respondedAt: null,
    createdAt: past.toISOString(),
  },
  paymentIntent: {
    // snake_case to mirror the real API contract (CreateOrderResponse / POST /bookings).
    razorpay_order_id: 'order_test_001',
    razorpay_key: 'rzp_test_xxx',
    amount_paise: 11200,
    currency: 'INR',
  },
  workshop: {
    id: '01HX00000000000000000000W1',
    academyId: '01HX00000000000000000000AC1',
    type: 'offline',
    title: "Rhythm House Intro Masterclass — Beginner's Guide to Hindustani Music",
    category: 'music',
    description: "A 2-hour masterclass with Anand R covering raga families, sur, and laya.",
    startAt: new Date(now.getTime() + 11 * 24 * 60 * 60 * 1000).toISOString(),
    durationMin: 120,
    // startAt + durationMin, same rule the real write path applies.
    endAt: new Date(now.getTime() + 11 * 24 * 60 * 60 * 1000 + 120 * 60_000).toISOString(),
    location: 'Hauz Khas, New Delhi',
    capacity: 30,
    registeredCount: 26,
    pricePaise: 39900,
    status: 'upcoming',
    createdAt: past.toISOString(),
  },
  event: {
    id: '01HX00000000000000000000E1',
    type: 'competition',
    title: 'Findemy Utsav — Season 1',
    category: ['music', 'dance', 'arts', 'yoga'],
    description: 'A nationwide showcase across music, dance, arts and yoga — 42 spots left.',
    startAt: new Date(now.getTime() + 16 * 24 * 60 * 60 * 1000).toISOString(),
    endAt: new Date(now.getTime() + 18 * 24 * 60 * 60 * 1000).toISOString(),
    location: 'All India · Online',
    lat: 28.5494,
    lng: 77.2001,
    capacity: 100,
    enrolledCount: 58,
    organizerName: 'Findemy',
    coverColor: '#1A1614',
    createdAt: past.toISOString(),
  },
};

// The set of academies the discover/search screen lists in MOCK mode. Shared by
// the list handler (GET /academies) and the detail handler (GET /academies/:id)
// so a tapped card opens the academy it actually points at.
const discoverAcademies = [
  // The Rhythm House (the primary fixture)
  {
    ...fixtures.academy,
    distance_km: 1.2,
    review_count: 84,
    trial_fee_paise: 15000,
    monthly_fee_paise: 220000,
  },
  {
    id: '01HX00000000000000000000AC2',
    name: 'Nrityanjali Dance Studio',
    category: 'dance',
    address: 'Saket, New Delhi',
    lat: 28.5245,
    lng: 77.2066,
    verified: true,
    onlineAvailable: false,
    rating: 4.8,
    ratingCount: 47,
    review_count: 47,
    bio: 'Bharatanatyam, Bollywood, and contemporary — disciplined classical foundations.',
    distance_km: 0.8,
    trial_fee_paise: 10000,
    monthly_fee_paise: 180000,
    createdAt: past.toISOString(),
  },
  {
    id: '01HX00000000000000000000AC3',
    name: 'Kalapatra Studio',
    category: 'arts',
    address: 'Green Park, New Delhi',
    lat: 28.5583,
    lng: 77.2065,
    verified: true,
    onlineAvailable: true,
    rating: 4.7,
    ratingCount: 32,
    review_count: 32,
    bio: 'Watercolours, oils and sketching — for all ages.',
    distance_km: 1.6,
    trial_fee_paise: 0,
    monthly_fee_paise: 250000,
    createdAt: past.toISOString(),
  },
  {
    id: '01HX00000000000000000000AC4',
    name: 'Shanti Yoga Mandir',
    category: 'yoga',
    address: 'Saket, New Delhi',
    lat: 28.5245,
    lng: 77.2066,
    verified: false,
    onlineAvailable: true,
    rating: 4.6,
    ratingCount: 51,
    review_count: 51,
    bio: 'Hatha and Ashtanga yoga — dawn and dusk classes.',
    distance_km: 3.1,
    trial_fee_paise: 0,
    monthly_fee_paise: 150000,
    createdAt: past.toISOString(),
  },
];

// The brand and its locations, as every academy auth envelope now returns them. Two branches
// so mock mode actually exercises the switcher and the group-scoped inboxes.
function mockGroup() {
  return {
    id: '01HX00000000000000000000G1',
    name: 'The Rhythm House',
    category: 'music',
    bio: fixtures.academy.bio ?? null,
    tagline: null,
    specialities: [],
    branches: [
      { ...fixtures.academy, branch_label: 'Hauz Khas' },
      fixtures.academyBranch2,
    ],
  };
}

const categoryLabel: Record<string, string> = {
  music: 'Music',
  dance: 'Dance',
  arts: 'Art',
  yoga: 'Yoga',
};

// --- Programs (approximate wire mappers for MOCK mode) ---
// The real API groups an academy's batches under Programs; here each mock batch becomes a
// single-batch program so mock-mode academy detail + GET /programs/:id return the same shape.
const mockProgramId = (batchId: string) => `${batchId}-P`;

function mockBatchWire(b: any, coachName: string, timings: any[] = []) {
  return {
    id: b.id,
    academy_id: b.academyId,
    coach_id: b.coachId,
    program_id: mockProgramId(b.id),
    coach_name: coachName,
    title: b.title,
    category: b.category,
    name: b.name ?? b.title,
    min_age: b.minAge ?? null,
    max_age: b.maxAge ?? null,
    session_format: b.sessionFormat ?? 'group',
    gender: b.gender ?? 'anyone',
    description: b.description ?? null,
    things_to_know: b.thingsToKnow ?? [],
    capacity: b.capacity,
    trial_fee_paise: b.trialFeePaise,
    monthly_fee_paise: b.monthlyFeePaise,
    quarterly_discount_bps: b.quarterlyDiscountBps ?? 0,
    annual_discount_bps: b.annualDiscountBps ?? 0,
    sessions_per_month: b.sessionsPerMonth ?? 4,
    status: b.status ?? 'active',
    mode: b.mode ?? 'in-studio',
    trial_spots: Math.max(0, (b.capacity ?? 0) - 1),
    created_at: b.createdAt,
    timings,
  };
}

function mockProgram(b: any, coachName: string, timings: any[] = []) {
  const bw = mockBatchWire(b, coachName, timings);
  return {
    id: bw.program_id,
    academy_id: b.academyId,
    title: b.title,
    category: b.category,
    level: b.level ?? 'Beginner',
    description: b.description ?? null,
    things_to_know: b.thingsToKnow ?? [],
    coach_names: [coachName],
    trial_fee_paise: bw.trial_fee_paise,
    monthly_fee_paise_from: bw.monthly_fee_paise,
    total_seats_left: bw.trial_spots,
    batches: [bw],
  };
}

/** The mock account's learners: just the account holder (no children). */
function mockLearners() {
  return [
    {
      id: 'lrn_self_mock',
      name: fixtures.user.name,
      dob: null,
      age: fixtures.user.age,
      gender: null,
      avatar_initial: fixtures.user.avatarInitial,
      is_self: true,
      status: 'active',
    },
  ];
}

export const mockHandlers: Record<
  string,
  (req: FastifyRequest) => unknown | Promise<unknown>
> = {
  'POST-auth-otp-request': (req: any) => {
    const role = (req.body?.role ?? 'student') as 'student' | 'academy';
    const otpId = role === 'academy' ? 'mock_otp_academy' : 'mock_otp_student';
    return {
      otp_id: otpId,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      channel: 'sms',
    };
  },
  'POST-auth-otp-verify': (req: any) => {
    // verifyOtp doesn't carry `role` in its body, but the otp_id we issued
    // from POST-auth-otp-request is role-coded, so we route off that.
    const otpId = req.body?.otp_id ?? '';
    const inferredRole: 'student' | 'academy' =
      String(otpId).includes('academy') || req.body?.role === 'academy'
        ? 'academy'
        : 'student';
    if (inferredRole === 'academy') {
      return {
        access_token: 'mock_access_token',
        refresh_token: 'mock_refresh_token',
        is_new_user: false,
        account: {
          ...fixtures.academyAccount,
          owner_name: 'Ritwik Sen',
          email: 'ritwik@findemy.app',
        },
        group: mockGroup(),
        academy: fixtures.academy,
      };
    }
    return {
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      is_new_user: false,
      user: fixtures.user,
      attendance_otp: fixtures.user.attendanceOtp,
    };
  },
  'POST-auth-oauth-apple': (req: any) => {
    const role = (req.body?.role ?? 'student') as 'student' | 'academy';
    if (role === 'academy') {
      return {
        access_token: 'mock_access_token',
        refresh_token: 'mock_refresh_token',
        is_new_user: false,
        account: {
          ...fixtures.academyAccount,
          owner_name: 'Ritwik Sen',
          email: 'ritwik@findemy.app',
        },
        group: mockGroup(),
        academy: fixtures.academy,
      };
    }
    return {
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      is_new_user: false,
      user: fixtures.user,
      attendance_otp: fixtures.user.attendanceOtp,
    };
  },
  'POST-auth-oauth-google': (req: any) => {
    const role = (req.body?.role ?? 'student') as 'student' | 'academy';
    if (role === 'academy') {
      return {
        access_token: 'mock_access_token',
        refresh_token: 'mock_refresh_token',
        is_new_user: false,
        account: {
          ...fixtures.academyAccount,
          owner_name: 'Ritwik Sen',
          email: 'ritwik@findemy.app',
        },
        group: mockGroup(),
        academy: fixtures.academy,
      };
    }
    return {
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      is_new_user: false,
      user: fixtures.user,
      attendance_otp: fixtures.user.attendanceOtp,
    };
  },
  // Admin onboarding submit
  'POST-academy-onboarding': (req: any) => {
    const body = req.body ?? {};
    return {
      account: {
        ...fixtures.academyAccount,
        owner_name: body.ownerName ?? 'Ritwik Sen',
        phone: body.phone ?? fixtures.academyAccount.phone,
      },
      group: mockGroup(),
      academy: {
        ...fixtures.academy,
        name: body.academyName ?? fixtures.academy.name,
        category: body.category ?? fixtures.academy.category,
        address: body.city ?? fixtures.academy.address,
      },
    };
  },
  'POST-auth-refresh': () => ({
    access_token: 'mock_access_token',
    refresh_token: 'mock_refresh_token',
  }),
  'POST-auth-logout': () => ({}),
  'GET-me': () => ({
    user: fixtures.user,
    learners: mockLearners(),
  }),
  // Family accounts: the account holder only, so the app looks as it did before families.
  'GET-family-learners': () => ({ learners: mockLearners() }),
  'GET-me-stats': () => ({
    trials_count: 3,
    enrolled_count: 1,
    reviews_count: 2,
  }),
  'GET-me-enrollments': () => ({
    items: [
      {
        id: '01HX00000000000000000000EN1',
        // Flat fields matching what `(tabs)/profile.tsx` reads
        batch_id: fixtures.batch.id,
        batch_title: fixtures.batch.title,
        academy_id: fixtures.academy.id,
        academy_name: fixtures.academy.name,
        coach_id: fixtures.coach.id,
        coach_name: fixtures.coach.name,
        category: fixtures.academy.category,
        monthly_fee_paise: fixtures.batch.monthlyFeePaise,
        attended_count: 6,
        timings: [
          { day_of_week: 1, start_time: '18:00', duration_min: 60 },
          { day_of_week: 3, start_time: '18:00', duration_min: 60 },
        ],
        // Keep the nested objects too — academy detail / batch detail UIs use these
        batch: {
          ...fixtures.batch,
          coach_name: fixtures.coach.name,
          timings: [
            { day_of_week: 1, start_time: '18:00', duration_min: 60 },
            { day_of_week: 3, start_time: '18:00', duration_min: 60 },
          ],
        },
        academy: fixtures.academy,
        coach: fixtures.coach,
        started_at: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'active',
      },
    ],
    next_cursor: null,
  }),
  'PUT-me-onboarding': () => ({ user: fixtures.user }),
  'PUT-me-interests': () => ({ user: fixtures.user }),
  'GET-academies': (req: any) => {
    const query = req?.query ?? {};
    const q = String(query.q ?? '').trim().toLowerCase();
    const category = query.category ? String(query.category) : undefined;
    const online = query.online === true || query.online === 'true';
    const minRating = query.min_rating ? Number(query.min_rating) : 0;
    const radiusKm = query.radius_km ? Number(query.radius_km) : 0;

    const items = discoverAcademies.filter((a) => {
      if (category && a.category !== category) return false;
      // Real backend matches the academy NAME, case-insensitive (repo.searchAcademies).
      if (q && !a.name.toLowerCase().includes(q)) return false;
      if (online && !a.onlineAvailable) return false;
      if (minRating && a.rating < minRating) return false;
      if (radiusKm && (a.distance_km ?? Infinity) > radiusKm) return false;
      return true;
    });

    return { items, next_cursor: null };
  },
  'GET-academies-_id': (req: any) => {
    const id = req?.params?.id;
    const academy =
      discoverAcademies.find((a) => a.id === id) ?? fixtures.academy;

    // The Rhythm House (the primary fixture) has hand-authored coach/batch/review/workshop.
    if (academy.id === fixtures.academy.id) {
      return {
        academy,
        coaches: [fixtures.coach],
        batches: [fixtures.batch],
        programs: [mockProgram(fixtures.batch, fixtures.coach.name)],
        reviews: [fixtures.review],
        workshops: [fixtures.workshop],
      };
    }

    // Other academies get category-appropriate detail so the page matches the
    // card the user tapped.
    const label = categoryLabel[academy.category] ?? 'Class';
    const coach = {
      ...fixtures.coach,
      id: `${academy.id}-C1`,
      academyId: academy.id,
      name: `${academy.name} Lead`,
      specialty: `${label} · 10 yrs`,
    };
    const batch = {
      ...fixtures.batch,
      id: `${academy.id}-B1`,
      academyId: academy.id,
      coachId: coach.id,
      category: academy.category,
      title: `${label} · Beginner`,
    };
    return {
      academy,
      coaches: [coach],
      batches: [batch],
      programs: [mockProgram(batch, coach.name)],
      reviews: [{ ...fixtures.review, id: `${academy.id}-R1`, academyId: academy.id }],
      workshops: [
        {
          ...fixtures.workshop,
          id: `${academy.id}-W1`,
          academyId: academy.id,
          title: `${academy.name} Masterclass`,
        },
      ],
    };
  },
  'GET-academies-_id-workshops': () => ({
    items: [fixtures.workshop],
  }),
  'GET-academies-_id-reviews': () => ({
    items: [fixtures.review],
    next_cursor: null,
  }),
  'GET-programs-_id': (req: any) => {
    const id = String(req?.params?.id ?? '');
    const batchId = id.endsWith('-P') ? id.slice(0, -2) : id;

    // Generic academies use batch id `${academyId}-B1`; primary fixture is fixtures.batch.
    if (batchId.endsWith('-B1')) {
      const academyId = batchId.slice(0, -3);
      const academy = discoverAcademies.find((a) => a.id === academyId);
      if (academy) {
        const label = categoryLabel[academy.category] ?? 'Class';
        const coach = { ...fixtures.coach, id: `${academy.id}-C1`, name: `${academy.name} Lead` };
        const batch = { ...fixtures.batch, id: batchId, academyId, coachId: coach.id, category: academy.category, title: `${label} · Beginner` };
        return {
          program: mockProgram(batch, coach.name),
          academy: {
            id: academy.id,
            name: academy.name,
            category: academy.category,
            address: academy.address,
            verified: academy.verified,
            rating: academy.rating,
            rating_count: academy.ratingCount,
            images: (academy as any).images ?? [],
          },
        };
      }
    }

    // Fall back to the primary fixture program.
    return {
      program: mockProgram(fixtures.batch, fixtures.coach.name),
      academy: {
        id: fixtures.academy.id,
        name: fixtures.academy.name,
        category: fixtures.academy.category,
        address: fixtures.academy.address,
        verified: fixtures.academy.verified,
        rating: fixtures.academy.rating,
        rating_count: (fixtures.academy as any).ratingCount ?? (fixtures.academy as any).rating_count ?? 0,
        images: (fixtures.academy as any).images ?? [],
      },
    };
  },
  'POST-bookings': () => ({
    booking: fixtures.booking,
    payment_intent: fixtures.paymentIntent,
  }),
  'GET-bookings-_id': () => ({ booking: fixtures.booking }),
  'POST-bookings-_id-cancel': () => ({
    booking: { ...fixtures.booking, status: 'cancelled' },
  }),
  'POST-bookings-_id-reschedule': () => ({
    booking: { ...fixtures.booking, status: 'rescheduled', rescheduleCount: 1 },
  }),
  'GET-trials-my': (req: any) => {
    const status = String(req.query?.status ?? 'upcoming');
    const flatTrial = (override: Partial<Record<string, unknown>>) => ({
      ...fixtures.trial,
      // Flat fields the profile / trials UI reads
      trial_at: fixtures.trial.trialAt,
      batch_id: fixtures.batch.id,
      batch_title: fixtures.batch.title,
      academy_id: fixtures.academy.id,
      academy_name: fixtures.academy.name,
      academy_address: fixtures.academy.address,
      coach_id: fixtures.coach.id,
      coach_name: fixtures.coach.name,
      trial_fee_paise: fixtures.batch.trialFeePaise,
      ...override,
    });
    if (status === 'past') {
      return {
        items: [
          flatTrial({
            id: '01HX00000000000000000000T2',
            status: 'attended',
            trial_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            trialAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          }),
        ],
      };
    }
    return { items: [flatTrial({})] };
  },
  'GET-trials-today': () => ({
    items: [
      {
        ...fixtures.trial,
        trial_at: fixtures.trial.trialAt,
        batch_title: fixtures.batch.title,
        academy_name: fixtures.academy.name,
        academy_address: fixtures.academy.address,
        coach_name: fixtures.coach.name,
      },
    ],
  }),
  'GET-trials-_id': () => ({
    trial: {
      ...fixtures.trial,
      trial_at: fixtures.trial.trialAt,
      batch_id: fixtures.batch.id,
      batch_title: fixtures.batch.title,
      academy_id: fixtures.academy.id,
      academy_name: fixtures.academy.name,
      academy_address: fixtures.academy.address,
      coach_id: fixtures.coach.id,
      coach_name: fixtures.coach.name,
    },
  }),
  'POST-studio-trials-_id-attendance': () => ({
    trial: { ...fixtures.trial, status: 'attended' },
    marked_at: new Date().toISOString(),
  }),
  'GET-studio-inbox': () => ({
    items: [{
      id: fixtures.trial.id,
      batch_id: fixtures.trial.batchId,
      batch_title: fixtures.batch.title,
      student_name: fixtures.user.name,
      student_phone: fixtures.user.phone,
      status: fixtures.trial.status,
      note: 'Interested in beginner guitar lessons',
      trial_at: fixtures.trial.trialAt,
      created_at: fixtures.trial.createdAt,
    }],
    counts: { new: 1, pending: 2, confirmed: 0 },
    next_cursor: null,
  }),
  'GET-studio-dashboard': () => ({
    inbox_counts: { new: 1, pending: 2, confirmed: 0 },
    active_trials: 3,
    earnings_summary: { this_month_paise: 19800, last_month_paise: 49500 },
    students_count: 12,
    recent_reviews: [fixtures.review],
  }),
  'GET-events': () => ({
    items: [
      // Mockup line 3934 — Spotlight: Findemy Utsav (already in fixtures.event)
      { ...fixtures.event, is_spotlight: true, prize_paise: 2500000, spots_left: 42 },

      // Mockup line 3944 — Natyam Classical Dance Showcase
      {
        id: '01HX00000000000000000000E2',
        type: 'competition',
        title: 'Natyam — Classical Dance Showcase',
        category: 'dance',
        description: '14 spots left · ₹10,000 prize pool · Kamani Auditorium, New Delhi.',
        startAt: new Date(now.getTime() + 11 * 24 * 60 * 60 * 1000 + 18 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(now.getTime() + 11 * 24 * 60 * 60 * 1000 + 21 * 60 * 60 * 1000).toISOString(),
        location: 'Kamani Auditorium, New Delhi',
        lat: 12.9892,
        lng: 77.5818,
        capacity: 30,
        enrolledCount: 16,
        organizerName: 'Findemy',
        coverColor: '#1E5C5A',
        prize_paise: 1000000,
        spots_left: 14,
        createdAt: past.toISOString(),
      },
      // Mockup line 4025 — Strings & Strums Guitar Battle
      {
        id: '01HX00000000000000000000E3',
        type: 'competition',
        title: 'Strings & Strums — Guitar Battle',
        category: 'music',
        description: '22 spots left · ₹5,000 prize pool · Online, Pan India.',
        startAt: new Date(now.getTime() + 18 * 24 * 60 * 60 * 1000 + 19 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(now.getTime() + 18 * 24 * 60 * 60 * 1000 + 21 * 60 * 60 * 1000).toISOString(),
        location: 'Online · Pan India',
        lat: 28.5494,
        lng: 77.2001,
        capacity: 30,
        enrolledCount: 8,
        organizerName: 'Findemy',
        coverColor: '#14110F',
        prize_paise: 500000,
        spots_left: 22,
        createdAt: past.toISOString(),
      },
      // Mockup line 4043 — 30-Second Bollywood Shuffle (reel battle, kept as competition since reels are out of scope)
      {
        id: '01HX00000000000000000000E4',
        type: 'competition',
        title: '30-Second Bollywood Shuffle',
        category: 'dance',
        description: 'Voting · 412 entries · ₹2,000 grand prize · Open to all.',
        startAt: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(now.getTime() + 12 * 24 * 60 * 60 * 1000).toISOString(),
        location: 'Online · Open to all',
        lat: 28.5494,
        lng: 77.2001,
        capacity: 1000,
        enrolledCount: 412,
        organizerName: 'Findemy',
        coverColor: '#C7556A',
        prize_paise: 200000,
        spots_left: 588,
        createdAt: past.toISOString(),
      },
      // Mockup line 4103 — Findemy Singing Championship Season 2 (Talent Hunt)
      {
        id: '01HX00000000000000000000E5',
        type: 'talent_hunt',
        title: 'Findemy Singing Championship — Season 2',
        category: 'music',
        description: 'Pan India · auditions May 1–15 · ₹25,000 grand prize.',
        startAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString(),
        location: 'Pan India · Hybrid',
        lat: 28.5494,
        lng: 77.2001,
        capacity: 500,
        enrolledCount: 128,
        organizerName: 'Findemy',
        coverColor: '#E8A33D',
        prize_paise: 2500000,
        spots_left: 372,
        createdAt: past.toISOString(),
      },
      // Meetup category — Dancers' Open Floor
      {
        id: '01HX00000000000000000000E6',
        type: 'meetup',
        title: "Dancers' Open Floor · Indiranagar",
        category: 'dance',
        description: 'Free-form meetup for kathak, contemporary, and street dancers.',
        startAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        endAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString(),
        location: 'Hauz Khas, New Delhi',
        lat: 28.5494,
        lng: 77.2001,
        capacity: 60,
        enrolledCount: 34,
        organizerName: 'Findemy Community',
        coverColor: '#5B2F3D',
        prize_paise: 0,
        spots_left: 26,
        createdAt: past.toISOString(),
      },
    ],
    next_cursor: null,
  }),
  'GET-events-_id': () => ({ event: fixtures.event }),
  'GET-batches-_id-slots': () => ({
    slots: [
      { ...fixtures.slot, slot_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
      { ...fixtures.slot, id: '01HX00000000000000000000S2', slot_time: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() },
    ],
  }),
  'POST-payments-order': () => ({
    razorpay_order_id: fixtures.paymentIntent.razorpay_order_id,
    razorpay_key: fixtures.paymentIntent.razorpay_key,
    amount_paise: fixtures.paymentIntent.amount_paise,
    currency: fixtures.paymentIntent.currency,
    breakdown: {
      base_paise: fixtures.paymentIntent.amount_paise,
      total_paise: fixtures.paymentIntent.amount_paise,
    },
  }),
  'GET-payments-_id': () => ({
    payment: { id: '01HX00000000000000000000P1', booking_id: fixtures.booking.id, amount_paise: 9900, status: 'captured', created_at: fixtures.booking.createdAt },
  }),
  'GET-studio-trials-_id': () => ({
    trial: {
      id: fixtures.trial.id,
      batch_id: fixtures.trial.batchId,
      batch_title: fixtures.batch.title,
      status: fixtures.trial.status,
      trial_at: fixtures.trial.trialAt,
      attendance_marked_at: fixtures.trial.attendanceMarkedAt,
    },
    student: { id: fixtures.user.id, name: fixtures.user.name, phone: fixtures.user.phone, age: fixtures.user.age, location: fixtures.user.location },
  }),
  'GET-studio-schedule': () => {
    const today = new Date();
    const at = (h: number, m = 0) => {
      const d = new Date(today);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    return {
      days: [
        {
          date: today.toISOString().slice(0, 10),
          items: [
            {
              batch_id: fixtures.batch.id,
              batch_title: fixtures.batch.title,
              category: fixtures.batch.category,
              start_time: at(10),
              end_time: at(11),
              status: 'now',
              enrolled_count: 6,
              capacity: 8,
              coach_name: fixtures.coach.name,
            },
            {
              batch_id: fixtures.batch.id,
              batch_title: fixtures.batch.title,
              category: fixtures.batch.category,
              start_time: at(18),
              end_time: at(19),
              status: 'upcoming',
              enrolled_count: 4,
              capacity: 8,
              coach_name: fixtures.coach.name,
            },
          ],
        },
      ],
    };
  },
  'GET-studio-batches': () => ({
    items: [{ ...fixtures.batch, coach_name: fixtures.coach.name }],
  }),
  'GET-studio-batches-_id': () => ({
    batch: { ...fixtures.batch, coach_name: fixtures.coach.name, timings: [{ day_of_week: 1, start_time: '10:00', duration_min: 60 }] },
  }),
  // L1/L2 attendance review. The old pair of keys here served the removed manual-marking
  // endpoints; `GET /studio/batches/:id/attendance` is now one batch's MONTH.
  'GET-studio-attendance': () => ({
    month: nowMonth,
    programs: [
      {
        program_id: 'prog_mock_1',
        title: fixtures.batch.title,
        level: 'Beginner',
        students: 1,
        batch_count: 1,
        held: 4,
        cancelled: 0,
        not_recorded: 1,
        avg_pct: 75,
        batches: [
          {
            batch_id: fixtures.batch.id,
            title: fixtures.batch.title,
            name: fixtures.batch.name ?? 'Weekday Evening',
            mode: 'in-studio',
            students: 1,
            held: 4,
            cancelled: 0,
            not_recorded: 1,
            avg_pct: 75,
          },
        ],
      },
    ],
  }),
  'GET-studio-batches-_id-attendance': () => ({
    month: nowMonth,
    batch: { id: fixtures.batch.id, title: fixtures.batch.title, name: fixtures.batch.name ?? 'Weekday Evening' },
    students: 1,
    held: 4,
    cancelled: 0,
    not_recorded: 1,
    avg_pct: 75,
    below_threshold: 0,
    sessions: [
      { session_date: pastDate, start_time: past.toISOString(), status: 'held', recorded: true, present: 1, expected: 1 },
    ],
    students_list: [
      {
        learner_id: 'lrn_self_mock',
        user_id: fixtures.user.id,
        name: fixtures.user.name,
        batch_id: fixtures.batch.id,
        present: 3,
        expected: 4,
        pct: 75,
        tier: 'active',
        reason_tag: null,
        left_on: null,
      },
    ],
  }),
  'GET-studio-students': () => ({
    items: [
      { id: fixtures.user.id, name: fixtures.user.name, phone: fixtures.user.phone, age: fixtures.user.age, batches: [{ title: fixtures.batch.title, category: fixtures.batch.category }], status: 'active' },
    ],
    next_cursor: null,
  }),
  'GET-studio-students-_id': () => ({
    student: { id: fixtures.user.id, name: fixtures.user.name, phone: fixtures.user.phone, age: fixtures.user.age, batches: [fixtures.batch.title], status: 'active' },
    attendance_history: [{ date: past.toISOString().slice(0, 10), present: true }],
  }),
  'GET-studio-reviews': () => ({
    items: [fixtures.review],
    next_cursor: null,
  }),
  'POST-studio-reviews-_id-respond': () => ({
    review: { ...fixtures.review, response: 'Thank you for your feedback!', responded_at: new Date().toISOString() },
  }),
  'GET-studio-earnings': () => ({
    total_paise: 19800,
    by_batch: [{ batch_id: fixtures.batch.id, batch_title: fixtures.batch.title, captured_paise: 19800, count: 2 }],
    payouts: [{ id: '01HX00000000000000000000PY1', amount_paise: 15000, status: 'processing', paid_at: undefined }],
  }),
  'GET-studio-settings': () => ({
    notifications: { new_trial_alerts: true, review_alerts: true },
    privacy: { show_phone: false },
  }),
  'PUT-studio-settings': () => ({
    settings: { notifications: { new_trial_alerts: true, review_alerts: true }, privacy: { show_phone: false } },
  }),
  'POST-studio-slots-publish': () => ({
    slots: [{ ...fixtures.slot }],
  }),
  'GET-studio-coaches': () => ({
    items: [fixtures.coach],
  }),
  'POST-push-register': () => ({}),
  'DELETE-push-register': () => ({}),
  'GET-health': () => ({ ok: true, version: 'mock', uptime_s: 0 }),
  'GET-studio-workshops': () => ({
    items: [fixtures.workshop],
  }),
  'POST-studio-workshops': () => ({
    workshop: { ...fixtures.workshop, id: '01HX00000000000000000000W2' },
  }),
  'PUT-studio-workshops-_id': () => ({
    workshop: fixtures.workshop,
  }),
  'DELETE-studio-workshops-_id': () => ({}),
  'POST-studio-batches': () => ({ batch: { ...fixtures.batch, id: '01HX00000000000000000000B2' } }),
  'PUT-studio-batches-_id': () => ({ batch: { ...fixtures.batch } }),
  'DELETE-studio-batches-_id': () => ({}),
  'GET-studio-batches-_id-students': () => ({
    students: [
      { id: fixtures.user.id, name: fixtures.user.name, phone: fixtures.user.phone, age: fixtures.user.age, attendance_pct: 82, last_seen: '3 days ago' },
    ],
  }),
  'POST-studio-coaches': () => ({ coach: { ...fixtures.coach, id: '01HX00000000000000000000C2' } }),
  'PUT-studio-coaches-_id': () => ({ coach: fixtures.coach }),
  'DELETE-studio-coaches-_id': () => ({}),
  'DELETE-studio-slots-_id': () => ({}),
  'PUT-studio-academy': () => ({ academy: fixtures.academy }),
  'GET-studio-academy': () => ({
    academy: {
      ...fixtures.academy,
      ownerName: fixtures.academyAccount.id,
      group_id: '01HX00000000000000000000G1',
      group_name: 'The Rhythm House',
      branch_label: 'Hauz Khas',
      financial_entity_id: '01HX00000000000000000000FE1',
    },
    // Shared payee — read-only from a branch screen. `branch_count` > 1 is what makes the app
    // warn that an edit reaches every location.
    financial_entity: mockFinancialEntity(),
  }),

  // --- Multi-branch ---
  'GET-studio-branches': () => ({
    group: {
      id: '01HX00000000000000000000G1',
      name: 'The Rhythm House',
      category: 'music',
      bio: fixtures.academy.bio ?? null,
      tagline: null,
      specialities: [],
    },
    active_branch_id: fixtures.academy.id,
    items: [
      {
        id: fixtures.academy.id,
        name: fixtures.academy.name,
        branch_label: 'Hauz Khas',
        address: fixtures.academy.address,
        lat: fixtures.academy.lat ?? null,
        lng: (fixtures.academy as any).lng ?? null,
        status: 'approved',
        verified: true,
        rating: fixtures.academy.rating ?? 0,
        rating_count: (fixtures.academy as any).ratingCount ?? 0,
        images: (fixtures.academy as any).images ?? [],
        financial_entity_id: '01HX00000000000000000000FE1',
        active_batch_count: 3,
        is_active: true,
        created_at: past.toISOString(),
      },
      {
        id: fixtures.academyBranch2.id,
        name: fixtures.academyBranch2.name,
        branch_label: fixtures.academyBranch2.branch_label,
        address: fixtures.academyBranch2.address,
        lat: fixtures.academyBranch2.lat,
        lng: fixtures.academyBranch2.lng,
        status: 'approved',
        verified: true,
        rating: fixtures.academyBranch2.rating,
        rating_count: 18,
        images: [],
        financial_entity_id: '01HX00000000000000000000FE1',
        active_batch_count: 1,
        is_active: false,
        created_at: past.toISOString(),
      },
    ],
  }),
  'GET-studio-financial-entities': () => ({ items: [mockFinancialEntity()] }),
};

// One payee backing BOTH mock branches — the case that makes "editing bank details from a
// branch screen" wrong, and the case a client must warn about before saving.
function mockFinancialEntity() {
  return {
    id: '01HX00000000000000000000FE1',
    label: 'Rhythm House Pvt Ltd',
    bank_kyc_status: 'verified',
    bank_account_number: '000111222333',
    bank_ifsc: 'HDFC0000001',
    bank_holder_name: 'Rhythm House Pvt Ltd',
    pan_number: 'ABCDE1234F',
    pan_image_url: null,
    aadhaar_last4: '4321',
    aadhaar_image_url: null,
    business_doc_urls: [],
    reserve_rate_bps: 1000,
    gst_registrations: [
      { id: 'gst_1', gst_number: '07ABCDE1234F1Z5', state: 'Delhi' },
      { id: 'gst_2', gst_number: '06ABCDE1234F1Z5', state: 'Haryana' },
    ],
    branches: [
      { id: fixtures.academy.id, name: fixtures.academy.name, branch_label: 'Hauz Khas' },
      {
        id: fixtures.academyBranch2.id,
        name: fixtures.academyBranch2.name,
        branch_label: fixtures.academyBranch2.branch_label,
      },
    ],
    _count: { branches: 2 },
    branch_count: 2,
  };
}
