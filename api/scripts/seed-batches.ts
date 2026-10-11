// Adds extra batches to an existing program so a single program shows a real
// multi-batch picker (different timing / coach / mode / age / format) in both apps.
// `level` is a program attribute, so every batch here shares the program's level.
//
// Idempotent: a batch is matched on (programId, title) and skipped if present,
// so re-running never duplicates rows.
//
// Usage: pnpm seed:batches            -> defaults to the "Guitar" program
//        pnpm seed:batches "Piano"    -> any program title from the seed catalog
import { PrismaClient, BatchGender, BatchMode, BatchStatus, SessionFormat } from '@prisma/client';

const prisma = new PrismaClient();

type BatchSpec = {
  // Academy-authored label; `level` belongs to the parent program now.
  name: string;
  minAge?: number;
  maxAge?: number;
  sessionFormat?: SessionFormat;
  gender?: BatchGender;
  coachName: string;
  capacity: number;
  trialFeePaise: number;
  monthlyFeePaise: number;
  quarterlyDiscountBps: number;
  annualDiscountBps: number;
  sessionsPerMonth: number;
  mode: BatchMode;
  status: BatchStatus;
  // dayOfWeek: 0 = Sunday … 6 = Saturday (matches BatchTiming in prisma/seed.ts).
  timings: { dayOfWeek: number; startTime: string; durationMin: number }[];
};

const SPECS: BatchSpec[] = [
  {
    name: 'Tue/Thu Evening',
    minAge: 12,
    coachName: 'Ravi Kumar',
    capacity: 10,
    trialFeePaise: 9900,
    monthlyFeePaise: 349900,
    quarterlyDiscountBps: 1000,
    annualDiscountBps: 2000,
    sessionsPerMonth: 8,
    mode: BatchMode.offline,
    status: BatchStatus.active,
    timings: [
      { dayOfWeek: 2, startTime: '18:00', durationMin: 60 },
      { dayOfWeek: 4, startTime: '18:00', durationMin: 60 },
    ],
  },
  {
    name: 'Mon/Fri Late Evening',
    minAge: 16,
    sessionFormat: SessionFormat.one_on_one,
    coachName: 'Ravi Kumar',
    capacity: 6,
    trialFeePaise: 14900,
    monthlyFeePaise: 499900,
    quarterlyDiscountBps: 1200,
    annualDiscountBps: 2500,
    sessionsPerMonth: 8,
    mode: BatchMode.offline,
    status: BatchStatus.active,
    timings: [
      { dayOfWeek: 1, startTime: '19:30', durationMin: 90 },
      { dayOfWeek: 5, startTime: '19:30', durationMin: 90 },
    ],
  },
  {
    name: 'Wed Online',
    coachName: 'Anita Desai',
    capacity: 15,
    trialFeePaise: 4900,
    monthlyFeePaise: 199900,
    quarterlyDiscountBps: 800,
    annualDiscountBps: 1500,
    sessionsPerMonth: 4,
    mode: BatchMode.online,
    status: BatchStatus.active,
    timings: [{ dayOfWeek: 3, startTime: '20:00', durationMin: 45 }],
  },
  {
    name: 'Sat Morning Kids',
    minAge: 6,
    maxAge: 12,
    gender: BatchGender.female_only,
    coachName: 'Anita Desai',
    capacity: 12,
    trialFeePaise: 0,
    monthlyFeePaise: 249900,
    quarterlyDiscountBps: 1000,
    annualDiscountBps: 2000,
    sessionsPerMonth: 4,
    mode: BatchMode.offline,
    status: BatchStatus.active,
    timings: [{ dayOfWeek: 6, startTime: '09:00', durationMin: 60 }],
  },
];

async function main() {
  const programTitle = process.argv[2] ?? 'Guitar';

  // A program is BRAND-level, so it has no single academy — it has a group, and a batch of it
  // is operated by one BRANCH of that group. Batches land on the group's first branch unless a
  // branch id is passed as the second argument.
  const branchArg = process.argv[3];
  const program = await prisma.program.findFirst({
    where: { title: programTitle },
    include: {
      group: {
        select: {
          id: true,
          name: true,
          branches: { select: { id: true, name: true, branchLabel: true }, orderBy: { createdAt: 'asc' } },
        },
      },
    },
  });
  if (!program) {
    throw new Error(`No program titled "${programTitle}". Run \`pnpm seed\` first.`);
  }

  const branch = branchArg
    ? program.group.branches.find((b) => b.id === branchArg)
    : program.group.branches[0];
  if (!branch) {
    throw new Error(
      branchArg
        ? `Branch ${branchArg} is not part of "${program.group.name}".`
        : `"${program.group.name}" has no branches to attach batches to.`,
    );
  }

  const coaches = await prisma.coach.findMany({ where: { groupId: program.groupId } });
  if (coaches.length === 0) {
    throw new Error(`Academy "${program.group.name}" has no coaches to attach batches to.`);
  }
  const coachByName = new Map(coaches.map((c) => [c.name, c]));

  console.log(
    `Program "${program.title}" @ ${program.group.name} — ${branch.branchLabel ?? branch.name} (${program.id})`,
  );

  let created = 0;
  let skipped = 0;

  for (const spec of SPECS) {
    // title/category/description/thingsToKnow are denormalized from the parent
    // program — see the NOTE on model Batch in schema.prisma.
    const title = `${program.title} · ${spec.name}`;
    const existing = await prisma.batch.findFirst({
      where: { programId: program.id, title },
      select: { id: true },
    });
    if (existing) {
      console.log(`  skip   ${title} (already exists: ${existing.id})`);
      skipped++;
      continue;
    }

    // Fall back to the first coach so this also works on an academy with a different roster.
    const coach = coachByName.get(spec.coachName) ?? coaches[0];

    const batch = await prisma.batch.create({
      data: {
        academyId: branch.id,
        programId: program.id,
        coachId: coach.id,
        title,
        category: program.category,
        name: spec.name,
        ...(spec.minAge !== undefined ? { minAge: spec.minAge } : {}),
        ...(spec.maxAge !== undefined ? { maxAge: spec.maxAge } : {}),
        ...(spec.sessionFormat ? { sessionFormat: spec.sessionFormat } : {}),
        ...(spec.gender ? { gender: spec.gender } : {}),
        description: program.description,
        thingsToKnow: program.thingsToKnow,
        capacity: spec.capacity,
        trialFeePaise: spec.trialFeePaise,
        monthlyFeePaise: spec.monthlyFeePaise,
        quarterlyDiscountBps: spec.quarterlyDiscountBps,
        annualDiscountBps: spec.annualDiscountBps,
        sessionsPerMonth: spec.sessionsPerMonth,
        mode: spec.mode,
        status: spec.status,
        timings: { create: spec.timings },
      },
      select: { id: true },
    });
    console.log(`  create ${title} — coach ${coach.name}, ${spec.mode}, ${spec.sessionFormat ?? 'group'}, ${batch.id}`);
    created++;
  }

  const total = await prisma.batch.count({ where: { programId: program.id } });
  console.log(`\ncreated=${created} skipped=${skipped} — program now has ${total} batches`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
