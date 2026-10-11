import { z } from 'zod';

export type Category = 'music' | 'dance' | 'arts' | 'yoga';

export const CategoryEnum = z.enum(['music', 'dance', 'arts', 'yoga']);

// ─── Shared platform enums & conventions (S0.1 — master-execution-plan §1) ───
// Money: all amounts are integer **paise** (server-authoritative; clients never
//        compute/send amounts). Field suffix `_paise` / `Paise`.
// Discount: **basis points** (bps); product cap **3000 (30%)**. Field suffix `Bps`.
// Time: store/transport UTC; render IST client-side.

/**
 * Batch / trial delivery mode — canonical **wire** vocabulary.
 * Note: the DB enum `BatchMode` stores `online | offline` where `offline` ≡ in-studio;
 * the API maps `offline → 'in-studio'` on read. (Decision: Option A, no DB migration.)
 */
export const ModeEnum = z.enum(['in-studio', 'online']);
export type Mode = z.infer<typeof ModeEnum>;

/** Subscription plan terms. `biannual` is removed (S0.2) — monthly | quarterly | annual. */
export const PlanEnum = z.enum(['monthly', 'quarterly', 'annual']);
export type Plan = z.infer<typeof PlanEnum>;

// ── Shared contract constants (P2) — values both client and server must agree on.
// Backend-only policy (commission rate, refund windows) lives in backend/api/src/config.ts.
/** Months per plan term (the discount % comes from the batch, S1.3/S2.3). */
export const PLAN_MONTHS: Record<Plan, number> = { monthly: 1, quarterly: 3, annual: 12 };
/** Academy-set discounts cap at 30% (S0.1/S1.3). */
export const DISCOUNT_BPS_CAP = 3000;

/** Pause terms — a pause is always a whole number of WEEKS, so that extending the paid period by
 *  `7 × weeks` days re-delivers exactly the classes that were missed: `BatchTiming` repeats weekly
 *  by `dayOfWeek`, so a 7-day shift reproduces the same weekday pattern. Sub-week pauses would
 *  break that identity, which is why `one_month` was dropped rather than a 10-day option added. */
export const PauseDurationEnum = z.enum(['one_week', 'two_weeks']);
export type PauseDuration = z.infer<typeof PauseDurationEnum>;

/** Weeks consumed by each selectable pause length. */
export const PAUSE_DURATION_WEEKS: Record<PauseDuration, number> = { one_week: 1, two_weeks: 2 };

/** Pause allowance per PAID PERIOD, by plan (owner decision 2026-09-05): monthly buys 1 week,
 *  quarterly buys 2. The allowance refreshes on every renewal — it is per period, not per
 *  enrolment lifetime — and quarterly's 2 weeks may be split into two separate 1-week pauses.
 *  `annual` is retained only until the plan itself is retired (see commission-model-v2.md §6);
 *  it deliberately does NOT scale past quarterly. */
export const PAUSE_WEEKS_PER_PERIOD: Record<Plan, number> = { monthly: 1, quarterly: 2, annual: 2 };

/** Pause lengths a plan can actually select, given its per-period allowance. */
export function pauseDurationsForPlan(plan: Plan): PauseDuration[] {
  const allowance = PAUSE_WEEKS_PER_PERIOD[plan] ?? 1;
  return (Object.keys(PAUSE_DURATION_WEEKS) as PauseDuration[]).filter(
    (d) => PAUSE_DURATION_WEEKS[d] <= allowance,
  );
}
/** OTP lengths — login (phone verify) vs trial attendance (S2.2). */
export const OTP_LOGIN_LENGTH = 6;
export const OTP_ATTENDANCE_LENGTH = 4;

/** How attendance is captured, by booking type:
 *  trial → `otp`, in-studio regular class → `qr`, online regular class → `auto_join`. */
export const AttendanceModeEnum = z.enum(['otp', 'qr', 'auto_join']);
export type AttendanceMode = z.infer<typeof AttendanceModeEnum>;

/** Canonical API error codes. Envelope: `{ error: { code, message, fields? } }`. */
export const ApiErrorCodeEnum = z.enum([
  'VALIDATION', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INTERNAL', 'CONFIG',
  'OTP_EXPIRED', 'OTP_INVALID', 'OTP_MISMATCH',
  'SLOT_UNAVAILABLE', 'RESCHEDULE_LIMIT', 'CANCELLATION_WINDOW_CLOSED', 'ALREADY_CANCELLED',
  'NOT_ENROLLED', 'NOT_REGISTERED', 'REGISTRATION_CLOSED', 'NOT_IN_SESSION', 'NOT_ONLINE',
  // The `X-Branch-Id` header names a branch this login may not act on. Distinct from a plain
  // FORBIDDEN because it is the one 403 a CLIENT CAN REPAIR ITSELF: drop the persisted branch,
  // refetch the session, and land on a branch the subject still holds. String-sniffing the
  // message to detect that is not a contract, so it gets its own code.
  'BRANCH_FORBIDDEN',
  // The pause allowance for this paid period is spent (1 week monthly / 2 quarterly). Its own code
  // because the client shows the REMAINING weeks and when they refresh, which it cannot get by
  // string-sniffing a VALIDATION message.
  'PAUSE_ALLOWANCE_EXCEEDED',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeEnum>;

export const OtpRequest = z.object({
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  role: z.enum(['student', 'academy']),
});

// Legacy alias
export const LoginRequest = OtpRequest;

export const OtpVerifyRequest = z.object({
  otp_id: z.string(),
  code: z.string().length(6),
});

export const VerifyOtpRequest = OtpVerifyRequest;

export const RefreshRequest = z.object({
  refresh_token: z.string(),
});

export const LogoutRequest = z.object({
  refresh_token: z.string(),
});

export const OnboardingRequest = z.object({
  name: z.string().min(1).max(100),
  age: z.number().int().min(3).max(100).optional(),
  location: z.string().max(200),
  lat: z.number(),
  lng: z.number(),
  interests: z.array(CategoryEnum),
});

export const UpdateInterestsRequest = z.object({
  interests: z.array(CategoryEnum),
  /** Keys from ART_FORMS. Optional so older app builds that only send categories keep working. */
  art_forms: z.array(z.string()).optional(),
});

export const CreateBookingRequest = z.object({
  batch_id: z.string(),
  trial_at: z.string(), // S2.1: chosen class-session datetime (ISO)
  // Family accounts: who attends. Omitted → the account holder.
  learner_id: z.string().optional(),
});

export const RescheduleRequest = z.object({
  new_trial_at: z.string(),
});

export const CreateOrderRequest = z.object({
  booking_id: z.string(),
});

// S4.3: review from an attended trial OR an enrolment (one per user+academy).
// trial path: only trial_id needed (pins academy+batch). enrolment path: academy_id + batch_id.
export const CreateReviewRequest = z.object({
  source: z.enum(['trial', 'enrollment']),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
  trial_id: z.string().optional(),
  academy_id: z.string().optional(),
  batch_id: z.string().optional(),
});

export const MarkAttendanceRequest = z.object({
  otp_code: z.string().length(6),
});

export const PushRegisterRequest = z.object({
  expo_token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

export type OtpRequestType = z.infer<typeof OtpRequest>;
export type OtpVerifyRequestType = z.infer<typeof OtpVerifyRequest>;
export type RefreshRequestType = z.infer<typeof RefreshRequest>;
export type LogoutRequestType = z.infer<typeof LogoutRequest>;
export type OnboardingRequestType = z.infer<typeof OnboardingRequest>;
export type UpdateInterestsRequestType = z.infer<typeof UpdateInterestsRequest>;
export type CreateBookingRequestType = z.infer<typeof CreateBookingRequest>;
export type RescheduleRequestType = z.infer<typeof RescheduleRequest>;
export type CreateOrderRequestType = z.infer<typeof CreateOrderRequest>;

export type PaymentBreakdown = {
  base_paise: number;
  total_paise: number;
};

export type CreateOrderResponse =
  | {
      free?: false;
      razorpay_order_id: string;
      razorpay_key: string;
      amount_paise: number;
      currency: string;
      breakdown: PaymentBreakdown;
    }
  | {
      /** Trial fee is 0: no Razorpay order exists. Confirm via `payments.confirmFree`. */
      free: true;
      razorpay_order_id: null;
      razorpay_key: null;
      amount_paise: 0;
      currency: string;
      breakdown: PaymentBreakdown;
    };

export type CreateReviewRequestType = z.infer<typeof CreateReviewRequest>;
export type MarkAttendanceRequestType = z.infer<typeof MarkAttendanceRequest>;
export type PushRegisterRequestType = z.infer<typeof PushRegisterRequest>;

export type OAuthProvider = 'apple' | 'google';

export interface OAuthLoginRequest {
  idToken: string;
  nonce?: string;
  role: 'student' | 'academy';
}

export type AuthLoginResponse = {
  access_token: string;
  refresh_token: string;
  is_new_user: boolean;
  user?: Record<string, unknown>;
  account?: Record<string, unknown>;
  academy?: Record<string, unknown>;
  attendance_otp?: string;
};

export type User = {
  id: string;
  name: string;
  phone: string;
  age?: number;
  location?: string;
  interests: Category[];
  art_forms?: string[];
};

// ---------- Amenities ----------

// What a BRANCH physically offers on site. A fixed catalogue rather than free text: these are
// meant to be scanned as icons, compared across academies and (later) filtered on, none of
// which survives "AC" / "Air conditioning" / "A.C." being three different strings.
// Branch-level, never brand-level — parking and a lift belong to a building, not a business.
// Adding a key here is safe; RENAMING one orphans the value already stored on every academy.
export const AMENITIES = [
  { key: 'parking', label: 'Parking' },
  { key: 'ac', label: 'Air conditioned' },
  { key: 'washroom', label: 'Washroom' },
  { key: 'drinking_water', label: 'Drinking water' },
  { key: 'wheelchair', label: 'Wheelchair accessible' },
  { key: 'lift', label: 'Lift access' },
  { key: 'waiting_area', label: 'Waiting area' },
  { key: 'cctv', label: 'CCTV secured' },
  { key: 'wifi', label: 'Wi-Fi' },
  { key: 'instruments', label: 'Instruments provided' },
  { key: 'changing_room', label: 'Changing room' },
  { key: 'lockers', label: 'Lockers' },
  { key: 'first_aid', label: 'First aid' },
  { key: 'mirrored_studio', label: 'Mirrored studio' },
] as const;

export type AmenityKey = (typeof AMENITIES)[number]['key'];

export const AMENITY_KEYS = AMENITIES.map((a) => a.key) as AmenityKey[];

const AMENITY_LABELS: Record<string, string> = Object.fromEntries(
  AMENITIES.map((a) => [a.key, a.label]),
);

/** A key stored before it was retired from the catalogue still has to render as something. */
export function amenityLabel(key: string): string {
  return AMENITY_LABELS[key] ?? key.replace(/_/g, ' ');
}

export function isAmenityKey(key: string): key is AmenityKey {
  return key in AMENITY_LABELS;
}

// ---------- Art forms ----------

// The specific thing a student wants to pursue inside a broad Category ("Guitar" inside Music).
// Picked at signup right after the categories. Stored on the user as text, like amenities, so
// adding or retiring an art form needs no migration.

export const ART_FORMS = {
  music: [
    { key: 'guitar', label: 'Guitar' },
    { key: 'piano', label: 'Piano / Keyboard' },
    { key: 'hindustani_vocal', label: 'Hindustani Classical Vocal' },
    { key: 'carnatic_vocal', label: 'Carnatic Vocal' },
    { key: 'western_vocal', label: 'Western Vocal' },
    { key: 'bollywood_singing', label: 'Bollywood Singing' },
    { key: 'tabla', label: 'Tabla' },
    { key: 'drums', label: 'Drums' },
    { key: 'violin', label: 'Violin' },
    { key: 'flute', label: 'Flute' },
    { key: 'sitar', label: 'Sitar' },
    { key: 'ukulele', label: 'Ukulele' },
  ],
  dance: [
    { key: 'bharatanatyam', label: 'Bharatanatyam' },
    { key: 'kathak', label: 'Kathak' },
    { key: 'odissi', label: 'Odissi' },
    { key: 'kuchipudi', label: 'Kuchipudi' },
    { key: 'bollywood_dance', label: 'Bollywood' },
    { key: 'hip_hop', label: 'Hip-Hop' },
    { key: 'contemporary', label: 'Contemporary' },
    { key: 'salsa', label: 'Salsa' },
    { key: 'ballet', label: 'Ballet' },
    { key: 'freestyle', label: 'Freestyle' },
  ],
  arts: [
    { key: 'painting', label: 'Painting' },
    { key: 'sketching', label: 'Sketching' },
    { key: 'pottery', label: 'Pottery' },
    { key: 'calligraphy', label: 'Calligraphy' },
    { key: 'madhubani', label: 'Madhubani' },
    { key: 'digital_art', label: 'Digital Art' },
    { key: 'crafts', label: 'Crafts' },
    { key: 'photography', label: 'Photography' },
  ],
  yoga: [
    { key: 'hatha', label: 'Hatha Yoga' },
    { key: 'power_yoga', label: 'Power Yoga' },
    { key: 'ashtanga', label: 'Ashtanga' },
    { key: 'vinyasa', label: 'Vinyasa' },
    { key: 'prenatal_yoga', label: 'Prenatal Yoga' },
    { key: 'meditation', label: 'Meditation' },
    { key: 'pranayama', label: 'Pranayama' },
  ],
} as const satisfies Record<Category, readonly { key: string; label: string }[]>;

export type ArtFormKey = (typeof ART_FORMS)[Category][number]['key'];

const ART_FORM_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(ART_FORMS).flatMap((list) => list.map((a) => [a.key, a.label])),
);

/** A key stored before it was retired from the catalogue still has to render as something. */
export function artFormLabel(key: string): string {
  return ART_FORM_LABELS[key] ?? key.replace(/_/g, ' ');
}

export function isArtFormKey(key: string): key is ArtFormKey {
  return key in ART_FORM_LABELS;
}

/** The BRAND an academy login belongs to. Owns programs, coaches and N branches. */
export type AcademyGroup = {
  id: string;
  name: string;
  category: Category;
  bio?: string | null;
  tagline?: string | null;
  specialities?: string[];
  branches?: Academy[];
};

export type AcademyAccount = {
  id: string;
  phone: string | null;
  /** The brand. Authorization is decided against this, never against `academyId`. */
  groupId?: string | null;
  /**
   * The branch this session lands on — the account's default, else the group's only branch.
   * Kept under its old name because every screen already reads it; what changed is that it is
   * now one of several branches rather than the account's single academy.
   */
  academyId: string | null;
  /** The branch to land on when no `X-Branch-Id` is sent. */
  defaultAcademyId?: string | null;
  ownerName: string | null;
  email?: string | null;
};

/** A BRANCH — one location of an `AcademyGroup`. */
export type Academy = {
  id: string;
  name: string;
  /** The location on its own ("Andheri West"); `name` is the composed display name. */
  branch_label?: string | null;
  category: Category;
  address: string;
  bio?: string;
  lat?: number;
  lng?: number;
  rating?: number;
  /** Every art form this branch teaches; always contains `category`. */
  categories?: Category[];
  images?: string[];
  status?: string;
  verified?: boolean;
};

export type Coach = {
  id: string;
  name: string;
  specialty: string;
  bio?: string;
  phone?: string;
};

/** Group class vs private tuition. Orthogonal to `Mode` — a 1-on-1 can be online or in-studio. */
export type SessionFormat = 'group' | 'one_on_one';

/** Academy-declared gender restriction on a batch. Display/intent only — not enforced at booking. */
export type BatchGender = 'anyone' | 'female_only';

export type Batch = {
  id: string;
  title: string;
  category: Category;
  /** Academy-authored label distinguishing sibling batches ("Weekday Evening"). */
  name: string;
  /** Target age range. Both null = all ages; `max_age` null = open-ended ("8+"). */
  min_age?: number | null;
  max_age?: number | null;
  session_format?: SessionFormat;
  gender?: BatchGender;
  /** Academy-authored "about this batch" copy. */
  description?: string | null;
  /** Academy-authored "things to know" bullet points. */
  things_to_know?: string[];
  coach_id: string;
  capacity: number;
  trial_fee_paise: number;
  monthly_fee_paise: number;
  // S1.3: academy-set discounts in bps, capped at 3000 (30%). Source of truth here;
  // consumed by enrol pricing in S2.3.
  quarterly_discount_bps?: number;
  annual_discount_bps?: number;
  // S3.4: number of classes per month (the explicit entitled count).
  sessions_per_month?: number;
  timings: BatchTiming[];
  // Batch discontinuation lifecycle: active → closing → ended (plan §7).
  status: 'active' | 'inactive' | 'closing' | 'ended';
  // S1.3: serialized as canonical `Mode` ('in-studio' | 'online'); DB stores online|offline,
  // mapped at the API boundary (lib/mode.ts).
  mode?: Mode;
  // S1.3: computed read-only trial spots = capacity − active enrollments.
  trial_spots?: number;
  coach_name?: string;
};

export type BatchTiming = {
  day_of_week: number;
  start_time: string;
  duration_min: number;
};

export const BatchTimingInput = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string(),
  duration_min: z.number().int().min(15).max(480),
});
export type BatchTimingInputType = z.infer<typeof BatchTimingInput>;

export type Slot = {
  id: string;
  batch_id: string;
  slot_time: string;
  capacity: number;
  reserved_count: number;
};

export type Trial = {
  id: string;
  batch_id: string;
  batch_title: string;
  student_id: string;
  student_name: string;
  status: 'booked' | 'attended' | 'missed' | 'cancelled';
  scheduled_at: string;
  coach_name?: string;
  mode?: Mode;
  source?: string;
  marked_at?: string;
};

export type TrialInboxItem = {
  id: string;
  learner_id?: string;
  guardian_name?: string | null;
  student_name: string;
  student_age?: number;
  batch_title: string;
  scheduled_at: string;
  status: Trial['status'];
  student_phone?: string;
  level?: string;
  category?: Category;
  coach_name?: string;
  trial_fee_paise?: number;
};

export type Review = {
  id: string;
  student_name: string;
  rating: number;
  comment?: string;
  response?: string;
  created_at: string;
  responded_at?: string;
  /** set once the student rewrites the review; null/absent means never edited */
  edited_at?: string | null;
  batch_title?: string;
  session_count?: number;
  /** rating <= 3 and no response yet — surfaced as a flagged card */
  flagged?: boolean;
};

export type ReviewsSummary = {
  average: number;
  count: number;
  breakdown: Record<1 | 2 | 3 | 4 | 5, number>;
  needs_reply: number;
};

// Academy-side students are LEARNERS: `id` is a learner id. A child has no login, so `phone` is
// the guardian's and `guardian_name` says whose it is (for an adult it is their own name).
export type StudentListItem = {
  id: string;
  learner_id?: string;
  user_id?: string;
  guardian_name?: string | null;
  name: string;
  phone?: string;
  age?: number;
  batches: { title: string; category: string }[];
  status: string;
};

export type StudentSnapshot = {
  id: string;
  learner_id?: string;
  user_id?: string;
  guardian_name?: string | null;
  name: string;
  phone: string;
  age?: number;
  location?: string;
};

export type Enrollment = {
  id: string;
  batch_id: string;
  batch_title: string;
  status: string;
};

// ---------- Family accounts ----------
// A parent account can hold several learners (children). The account holder is a learner too
// (`is_self`), so self-booking needs no special case. Attendance, enrollments and trials belong
// to a learner; login and payment belong to the account.

export type LearnerGender = 'male' | 'female' | 'other';

export type Learner = {
  id: string;
  name: string;
  /** 'yyyy-MM-dd' */
  dob: string | null;
  age: number | null;
  gender: LearnerGender | null;
  avatar_initial: string;
  is_self: boolean;
  status: 'active' | 'archived';
};

/**
 * A class's attendance code. Every class day has its own code per learner, and the API only
 * hands it out inside the window (10 min before start → end); otherwise `code` is null and
 * `opens_at` says when it appears.
 */
export type ClassAttendanceCode = {
  code: string | null;
  session_date: string | null;
  opens_at: string | null;
  closes_at: string | null;
};

/** The short form carried on bookings, trials, enrollments and classes. */
export type LearnerRef = { id: string; name: string };

export type AddLearnerRequest = {
  name: string;
  dob: string;
  gender?: LearnerGender;
  /** The guardian ticked the consent box. The API rejects the request without it. */
  consent: true;
};

export type UpdateLearnerRequest = {
  name?: string;
  dob?: string | null;
  gender?: LearnerGender | null;
};

// S3.1: a row in the student "Classes" tab (enrolled batch, never a trial).
export type ClassItem = {
  enrollment_id: string;
  learner_id?: string;
  learner?: LearnerRef;
  batch_id: string;
  batch_title: string;
  category: string;
  /** Academy-authored batch label. */
  batch_name?: string;
  /** The parent program's level (moved off Batch). */
  level: string;
  min_age?: number | null;
  max_age?: number | null;
  session_format?: SessionFormat;
  gender?: BatchGender;
  monthly_fee_paise: number;
  status: 'active' | 'paused' | 'past';
  // Batch discontinuation lifecycle — 'closing' shows a notice banner + disables renew.
  batch_status?: 'active' | 'inactive' | 'closing' | 'ended';
  started_at: string;
  current_period_end?: string;
  paused_until?: string;
  attended_count: number;
  /**
   * This calendar month, from the real record: classes attended out of classes the student was
   * expected at. A ratio and nothing more — the student never sees a day-by-day present/absent
   * list, because an absence can't be corrected in-app. See ai-usage/attendance-tracking_plan.md
   * decision 9.
   */
  month_present: number;
  month_expected: number;
  academy_id: string;
  academy_name: string;
  academy_address?: string;
  coach_name?: string;
  mode: Mode;
  timings: BatchTiming[];
};
export type MyClassesResponse = { active: ClassItem[]; past: ClassItem[] };

export type BatchAttendance = {
  date: string;
  present: boolean;
};

// ---------- Attendance review (academy L1 → L3b) ----------
// Sessions are records (ClassSession) and absence is a written fact, so these shapes describe a
// stored record rather than a projection. Every screen shares one window: a calendar month.
// See ai-usage/attendance-tracking_plan.md.

export type AttendanceTier = 'active' | 'irregular' | 'inactive';

/** One batch's month — an L1 program's picker entry. `avg_pct` is null when nothing counted. */
export type AttendanceBatchSummary = {
  batch_id: string;
  title: string;
  name: string;
  mode?: Mode;
  students: number;
  held: number;
  cancelled: number;
  /** Held sessions nobody checked into — excluded from every denominator, shown as a state. */
  not_recorded: number;
  avg_pct: number | null;
};

/**
 * L1 row — one PROGRAM's month, with its batches nested for the batch picker on the program
 * screen. Totals are weighted by students (not an average of batch percentages) and `students`
 * counts distinct people, so somebody in two batches of the same program counts once.
 */
export type AttendanceProgramSummary = {
  program_id: string;
  title: string;
  level: string;
  category: Category;
  /** First media item — the row's thumbnail. Null falls back to a coloured initial. */
  cover_url: string | null;
  students: number;
  batch_count: number;
  held: number;
  cancelled: number;
  not_recorded: number;
  avg_pct: number | null;
  batches: AttendanceBatchSummary[];
};

/** A session in the L2 list. `recorded: false` on a held session = "Not recorded". */
export type AttendanceSessionRow = {
  session_date: string; // 'yyyy-MM-dd' (IST)
  start_time: string | null;
  status: 'held' | 'cancelled';
  recorded: boolean;
  present: number;
  expected: number;
};

/** Why a student's row reads the way it does. */
export type AttendanceReasonTag = 'paused' | 'left' | 'joined_this_month' | 'new' | null;

/** A student in the L2 list. `pct` is null under 3 expected sessions ("1/1 · New"). */
export type AttendanceStudentRow = {
  /** Who attended — the id to open their record with. */
  learner_id: string;
  /** The enrolling account (the guardian, for a child). */
  user_id: string;
  name: string | null;
  batch_id: string;
  present: number;
  expected: number;
  pct: number | null;
  tier: AttendanceTier | null;
  reason_tag: AttendanceReasonTag;
  left_on: string | null;
};

export type AttendanceOverviewResponse = {
  month: string; // 'yyyy-MM'
  programs: AttendanceProgramSummary[];
};

export type BatchAttendanceResponse = {
  month: string;
  batch: { id: string; title: string; name: string };
  students: number;
  held: number;
  cancelled: number;
  not_recorded: number;
  avg_pct: number | null;
  /** Count of students under the Active boundary (75%) — the section header's alarm. */
  below_threshold: number;
  sessions: AttendanceSessionRow[];
  students_list: AttendanceStudentRow[];
};

export type SessionDetailResponse = {
  batch: { id: string; title: string; name: string };
  session_date: string;
  start_time: string | null;
  status: 'held' | 'cancelled';
  recorded: boolean;
  reason: string | null;
  present_count: number;
  absent_count: number;
  present: { learner_id: string; user_id: string; name: string | null; marked_at: string }[];
  absent: { learner_id: string; user_id: string; name: string | null }[];
};

/** One day on a student's month. `not_recorded` is the academy's miss, not the student's. */
export type StudentAttendanceDay = {
  session_date: string;
  batch_id: string;
  batch_title: string | null;
  start_time: string | null;
  state: 'present' | 'absent' | 'cancelled' | 'not_recorded';
  marked_at: string | null;
};

export type StudentAttendanceResponse = {
  month: string;
  student: {
    id: string;
    learner_id?: string;
    user_id?: string;
    name: string | null;
    phone: string | null;
    guardian_name?: string | null;
  };
  present: number;
  expected: number;
  pct: number | null;
  tier: AttendanceTier | null;
  /** The paid period, shown where money is the subject. */
  current_period: { present: number; expected: number; start_date: string | null; end_date: string | null } | null;
  days: StudentAttendanceDay[];
};

// S3.4: projected from BatchTiming (no slot_id); `cancelled` overlaid from ClassSession.
export type ScheduleItem = {
  batch_id: string;
  session_date: string; // 'yyyy-MM-dd' (IST)
  batch_title: string;
  category: string;
  capacity: number;
  enrolled_count: number;
  coach_name: string | null;
  mode: Mode;
  start_time: string;
  end_time: string;
  status: 'now' | 'upcoming' | 'done' | 'cancelled';
};

// Class notes — the academy's record of what a batch covered on a given day, read by its
// enrolled students. Anchored to the virtual session key (batch, session_date), like attendance.
// See ai-usage/class-notes_plan.md.
export type ClassNoteFile = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  /** `image` renders inline; `file` (PDF) downloads and opens in the OS viewer. */
  kind: 'image' | 'file';
};

export type ClassNote = {
  id: string;
  session_date: string; // 'yyyy-MM-dd' (IST)
  body: string | null;
  created_at: string;
  updated_at: string;
  files: ClassNoteFile[];
};

/** Student-facing list. `is_new` compares the note against Enrollment.notesSeenAt. */
export type StudentClassNote = ClassNote & { is_new: boolean };
export type StudentClassNotesResponse = {
  batch_title: string;
  /** The notes read as a thread from the academy — these carry the sender's identity. */
  academy_name: string;
  academy_image: string | null;
  unread_count: number;
  items: StudentClassNote[];
};

export type NotificationChannelPrefs = { push: boolean; email: boolean; whatsapp: boolean };

export type Settings = {
  notifications: {
    new_trial: NotificationChannelPrefs;
    classes: { reminder_30min: boolean; attendance_reminder: boolean };
    // `leaderboard` / `reels` were dropped: both features are post-MVP, so the switches
    // controlled notifications that cannot be sent.
    reviews_activity: { new_review: boolean };
    quiet_hours: { enabled: boolean; start: string; end: string };
  };
  privacy: {
    show_phone: boolean;
  };
  contact: { email?: string; whatsapp?: string };
};

/**
 * One row in the discover search bar's suggestion panel. `route` is where tapping it goes; a
 * `category` suggestion has none — the client applies it as a filter instead.
 */
export type SearchSuggestion = {
  kind: 'academy' | 'program' | 'workshop' | 'category';
  id: string;
  label: string;
  sublabel: string | null;
  category: Category | null;
  route: string | null;
  image: string | null;
};

/** What the search screen shows before anything is typed. */
export type SearchTrending = {
  trending_searches: string[];
  trending_academies: SearchSuggestion[];
  for_you: SearchSuggestion[];
  city_label: string | null;
};

export type WorkshopType = 'online' | 'offline';

export type Workshop = {
  id: string;
  academy_id: string;
  type: WorkshopType;
  title: string;
  /** Art form. Every discovery surface filters on it, so it is required, not optional. */
  category: Category;
  description: string;
  start_at: string;
  duration_min: number;
  /** Derived server-side from start_at + duration_min. Read-only: never sent on create/update. */
  end_at: string;
  location?: string;
  capacity: number;
  registered_count: number;
  price_paise: number;
  status: 'draft' | 'upcoming' | 'completed' | 'cancelled';
  /** Uploaded poster. Absent means the app falls back to its own generated cover. */
  cover_image_url?: string;
  /** Assigned teachers. Empty means the academy runs it itself — see `hosts`. */
  coaches?: { id: string; name: string }[];
  /**
   * Display names for "conducted by", with the OWNER as the fallback when no teacher is
   * assigned. This is what a student reads; `coaches` is what the studio edits.
   */
  hosts?: string[];
  /** derived: start_at <= now <= start_at + duration_min */
  live?: boolean;
  created_at: string;
};

export const CreateWorkshopRequest = z.object({
  type: z.enum(['online', 'offline']),
  title: z.string().min(1).max(200),
  // The art form students filter by. Required on create: a workshop without one shows up under
  // "All art forms" and nowhere else, which reads to the academy as if it never published.
  // `end_at` is deliberately absent — it is derived from start_at + duration_min server-side.
  category: CategoryEnum,
  description: z.string().min(1).max(2000),
  start_at: z.string(),
  duration_min: z.number().int().min(15).max(480),
  location: z.string().max(300).optional(),
  capacity: z.number().int().min(1).max(1000),
  price_paise: z.number().int().min(0),
  status: z.enum(['draft', 'upcoming']).optional(),
  // Nullable, not just optional: on update, `null` is how a cover is REMOVED. Leaving the key
  // out means "don't touch it", which is what `.partial()` already gives an editor.
  cover_image_url: z.string().url().max(500).nullable().optional(),
  // Who is CONDUCTING it — a list, because a workshop can be co-hosted. An empty list means
  // the academy is running it themselves, and then no teacher sees it in their own list.
  coach_ids: z.array(z.string().min(1)).optional(),
});

/** One ticket (workshop / meetup) or participant (competition) in a booking. */
export type TicketAttendee = {
  name: string;
  /** 0 is the first ticket (the account holder for workshops and meetups). */
  position: number;
  /** Set for competition participants: the family learner taking part. */
  learner_id: string | null;
};

/** Most tickets or participants one workshop / event booking can hold. */
export const MAX_TICKETS = 6;

/** A workshop / event booking's registration state for the signed-in account. */
export type TicketRegistrationStatus = {
  registered: boolean;
  status: 'pending' | 'confirmed' | 'cancelled' | null;
  registration_id: string | null;
  quantity: number | null;
  attendees: TicketAttendee[];
};

export type TicketRegisterResponse = {
  registration_id: string;
  requires_payment: boolean;
  /** Total for every ticket in the booking. */
  amount_paise: number;
  quantity: number;
};

// Academy-facing: one booking for a workshop (one account, 1–6 tickets).
export type WorkshopRegistrant = {
  id: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  registered_at: string;
  payment_status: 'initiated' | 'pending' | 'captured' | 'failed' | 'refunded' | null;
  amount_paise: number;
  /** Tickets in this booking. */
  quantity: number;
  /** One per ticket; position 0 is the account holder. */
  attendees: TicketAttendee[];
  user: { id: string; name: string; phone: string | null; age: number | null };
};

export type WorkshopRegistrationsResponse = {
  workshop: { id: string; title: string; capacity: number; registered_count: number; price_paise: number };
  registrations: WorkshopRegistrant[];
};

export type CreateWorkshopRequestType = z.infer<typeof CreateWorkshopRequest>;

export const UpdateWorkshopRequest = CreateWorkshopRequest.partial();
export type UpdateWorkshopRequestType = z.infer<typeof UpdateWorkshopRequest>;

export class ApiError extends Error {
  code: string;
  fields?: Record<string, string>;

  constructor(code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.code = code;
    this.fields = fields;
    this.name = 'ApiError';
  }
}

export type ApiErrorType = {
  code: string;
  message: string;
  fields?: Record<string, string>;
};

export type DashboardData = {
  inbox_counts: { new: number; pending: number; confirmed: number };
  active_trials: number;
  earnings_summary: { this_month_paise: number; last_month_paise: number };
  students_count: number;
  recent_reviews: Review[];
};

export type InboxResponse = {
  items: TrialInboxItem[];
  counts: { new: number; pending: number; confirmed: number };
  next_cursor: string | null;
};

export type EarningsPeriod = 'week' | 'month' | 'year';

export type EarningsTxn = {
  id: string;
  label: string;
  kind: string;
  dir: 'in' | 'out';
  amount_paise: number;
  commission_paise: number;
  net_paise: number;
  at: string;
};

export type EarningsData = {
  period: EarningsPeriod;
  total_paise: number; // back-compat = gross
  // S4.6: net of Findemy commission. gross − commission = net (events carry no commission).
  gross_paise: number;
  commission_paise: number;
  net_paise: number;
  /** total this period minus total previous period of same length */
  delta_paise: number;
  by_category: { category: string; captured_paise: number; commission_paise: number; net_paise: number; count: number }[];
  by_batch: { batch_id: string; batch_title: string; gross_paise: number; commission_paise: number; net_paise: number; count: number }[];
  transactions: EarningsTxn[];
  payouts: {
    id: string;
    amount_paise: number;
    status: string;
    paid_at?: string;
    bank_last4?: string;
    bank_name?: string;
  }[];
};

export type ActivityItem = {
  id: string;
  kind: 'trial_done' | 'review' | 'enrollment' | 'workshop_reg';
  icon_tone: 'jade' | 'marigold' | 'persimmon' | 'rose';
  title: string;
  subtitle?: string;
  at: string;
  action?: { label: string; route: string };
};

export type TrialDetail = Trial & {
  note?: string;
  payment_method?: string;
  distance_km?: number;
  batch_level?: string;
  category?: Category;
  slot_time?: string;
  trial_fee_paise?: number;
};
