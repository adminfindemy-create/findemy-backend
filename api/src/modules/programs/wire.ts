import { toWireMode } from '../../lib/mode.js';

// Shared catalog wire mappers. A Program owns many Batches; the student app consumes
// programs (each with nested batches). See
// ai-usage/final-app/plan/programs-and-batch-discontinuation.md.

type BatchRow = {
  id: string;
  academyId: string;
  coachId: string;
  programId: string;
  title: string;
  category: string;
  name: string;
  minAge: number | null;
  maxAge: number | null;
  sessionFormat: string;
  gender: string;
  description: string | null;
  thingsToKnow: string[];
  capacity: number;
  trialFeePaise: number;
  monthlyFeePaise: number;
  quarterlyDiscountBps: number;
  annualDiscountBps: number;
  sessionsPerMonth: number;
  status: string;
  mode: string;
  createdAt: Date;
  coach?: { name: string } | null;
  timings: { dayOfWeek: number; startTime: string; durationMin: number }[];
  _count: { enrollments: number };
};

export type BatchWire = ReturnType<typeof toBatchWire>;

export function toBatchWire(b: BatchRow) {
  return {
    id: b.id,
    academy_id: b.academyId,
    coach_id: b.coachId,
    program_id: b.programId,
    coach_name: b.coach?.name ?? null,
    title: b.title,
    category: b.category,
    name: b.name,
    min_age: b.minAge ?? null,
    max_age: b.maxAge ?? null,
    session_format: b.sessionFormat,
    gender: b.gender,
    description: b.description ?? null,
    things_to_know: b.thingsToKnow ?? [],
    capacity: b.capacity,
    trial_fee_paise: b.trialFeePaise,
    monthly_fee_paise: b.monthlyFeePaise,
    quarterly_discount_bps: b.quarterlyDiscountBps,
    annual_discount_bps: b.annualDiscountBps,
    sessions_per_month: b.sessionsPerMonth,
    status: b.status,
    mode: toWireMode(b.mode as any),
    trial_spots: Math.max(0, b.capacity - b._count.enrollments),
    created_at: b.createdAt.toISOString(),
    timings: b.timings.map((t) => ({
      day_of_week: t.dayOfWeek,
      start_time: t.startTime,
      duration_min: t.durationMin,
    })),
  };
}

type ProgramRow = {
  id: string;
  // Brand-level. A program has no single academy any more — the wire's `academy_id` is
  // derived from the batches, which ARE branch-scoped.
  groupId: string;
  title: string;
  category: string;
  level: string;
  description: string | null;
  thingsToKnow: string[];
  media?: { url: string; type: string }[];
};

// Build the program wire shape from the program row + its already-mapped batch wires.
// Aggregates (coach names, "from" pricing, seats) are derived across the batches.
export function toProgramWire(p: ProgramRow, batches: BatchWire[]) {
  const trialFees = batches.map((b) => b.trial_fee_paise);
  const monthlyFees = batches.map((b) => b.monthly_fee_paise);
  const coachNames = Array.from(
    new Set(batches.map((b) => b.coach_name).filter((n): n is string => !!n)),
  );
  return {
    id: p.id,
    group_id: p.groupId,
    // The branch these batches belong to. On a branch-scoped read every batch shares it; on a
    // brand-wide read it is the first batch's branch, and clients should prefer `group_id`.
    academy_id: batches[0]?.academy_id ?? null,
    title: p.title,
    category: p.category,
    level: p.level,
    description: p.description ?? null,
    things_to_know: p.thingsToKnow ?? [],
    media: (p.media ?? []).map((m) => ({ url: m.url, type: m.type })),
    coach_names: coachNames,
    // "from" pricing across the program's batches (null if the program has no batches).
    trial_fee_paise: trialFees.length ? Math.min(...trialFees) : null,
    monthly_fee_paise_from: monthlyFees.length ? Math.min(...monthlyFees) : null,
    total_seats_left: batches.reduce((s, b) => s + b.trial_spots, 0),
    batches,
  };
}
