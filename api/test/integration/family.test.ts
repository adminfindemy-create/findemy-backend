/**
 * Family accounts against a real database: one parent, two children, a batch, the attendance
 * register, the academy screens and the session closer. Run with `pnpm test:integration`
 * against a DEV database (DATABASE_URL) — it writes its own users, learners, enrollments and a
 * temporary batch timing, and removes them afterwards. The closer it runs is the real one, so it
 * also finalises any other open session that is due on that database.
 *
 * Picks an existing active, in-studio batch with no age or gender rule (seeded data has several)
 * and skips when there is none.
 *
 * See ai-usage/final-app/plan/family-accounts.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.MOCK = '0';

const { prisma } = await import('../../src/lib/prisma.js');
const { buildApp } = await import('../../src/app.js');
const { signAccessToken } = await import('../../src/lib/tokens.js');
const authRepo = await import('../../src/modules/auth/repo.js');
const { newId } = await import('../../src/lib/id.js');
const { istDateKey } = await import('../../src/lib/ist.js');
const { closeFinishedSessions } = await import('../../src/workers/session-close.js');
const { getTrialAvailability } = await import('../../src/modules/batches/service.js');
const { classCode } = await import('../../src/lib/attendance-code.js');

type Learner = { id: string; name: string };

const target = await prisma.batch
  .findFirst({
    where: {
      status: 'active',
      mode: 'offline',
      minAge: null,
      maxAge: null,
      gender: 'anyone',
      academy: { group: { accounts: { some: {} } } },
    },
    select: { id: true, academyId: true, academy: { select: { groupId: true } } },
  })
  .catch(() => null);
const owner = target
  ? await prisma.academyAccount.findFirst({ where: { groupId: target.academy.groupId }, select: { id: true } })
  : null;

describe.skipIf(!target || !owner)('family accounts (database)', () => {
  const BATCH = target!.id;
  const ACADEMY = target!.academyId;
  const created = { users: [] as string[], timings: [] as string[], sessions: [] as string[], todaySessionExisted: true };
  const today = istDateKey(new Date());
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const yesterdayDate = new Date(todayDate.getTime() - 86_400_000);

  let app: any;
  let academyToken: string;
  let varun: { id: string; token: string };
  let other: { id: string; token: string };
  let ravi: { id: string; token: string; learnerId: string };
  /** Today's code for a learner in this batch — what the app shows and the academy accepts. */
  const codeFor = (learnerId: string) => classCode(learnerId, BATCH, today);
  let aarav: Learner;
  let anaya: Learner;

  const call = async (token: string, method: string, url: string, payload?: unknown, academy = false) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (academy) headers['x-branch-id'] = ACADEMY;
    const res = await app.inject({ method, url, payload, headers });
    let body: any;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = res.body;
    }
    return { status: res.statusCode as number, body, raw: res.body as string };
  };

  const mkUser = async (name: string) => {
    const id = newId();
    await authRepo.createUser({
      id,
      phone: `+91990${id.slice(-7)}`,
      name,
      attendanceOtp: String(1000 + Math.floor(Math.random() * 8999)),
      location: 'Delhi',
      lat: 0,
      lng: 0,
      interests: [],
    });
    created.users.push(id);
    return { id, token: await signAccessToken({ sub: id, role: 'student' }) };
  };

  const enroll = async (userId: string, learnerId: string) => {
    const e = await prisma.enrollment.create({
      data: { id: newId(), userId, learnerId, batchId: BATCH, status: 'active', startedAt: new Date(yesterdayDate.getTime() - 86_400_000) },
    });
    await prisma.enrollmentPeriod.create({
      data: {
        id: newId(),
        enrollmentId: e.id,
        packageType: 'monthly',
        startDate: new Date(yesterdayDate.getTime() - 86_400_000),
        endDate: new Date(todayDate.getTime() + 20 * 86_400_000),
        amountPaise: 0,
      },
    });
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // The register creates today's session on the first mark; remove it after only if we made it.
    created.todaySessionExisted = !!(await prisma.classSession.findUnique({
      where: { batchId_sessionDate: { batchId: BATCH, sessionDate: todayDate } },
    }));
    academyToken = await signAccessToken({ sub: owner!.id, role: 'academy', group_id: target!.academy.groupId } as any);

    varun = await mkUser('Varun');
    other = await mkUser('Other Parent');
    const r = await mkUser('Ravi Adult');
    const self = await prisma.user.findUniqueOrThrow({ where: { id: r.id } });
    ravi = { ...r, learnerId: self.selfLearnerId! };

    // A class running now (for the live register) and one yesterday (for the closer).
    const nowIst = new Date(Date.now() + 330 * 60_000);
    const hhmm = `${String(nowIst.getUTCHours()).padStart(2, '0')}:${String(nowIst.getUTCMinutes()).padStart(2, '0')}`;
    for (const [day, startTime] of [
      [todayDate.getUTCDay(), hhmm],
      [yesterdayDate.getUTCDay(), '06:00'],
    ] as const) {
      const t = await prisma.batchTiming.create({ data: { batchId: BATCH, dayOfWeek: day, startTime, durationMin: 60 } });
      created.timings.push(t.id);
    }
  });

  afterAll(async () => {
    const lids = (
      await prisma.guardianship.findMany({ where: { userId: { in: created.users } }, select: { learnerId: true } })
    ).map((g) => g.learnerId);
    await prisma.batchAttendance.deleteMany({ where: { learnerId: { in: lids } } });
    const enr = await prisma.enrollment.findMany({ where: { learnerId: { in: lids } }, select: { id: true } });
    await prisma.enrollmentPeriod.deleteMany({ where: { enrollmentId: { in: enr.map((e) => e.id) } } });
    await prisma.enrollment.deleteMany({ where: { learnerId: { in: lids } } });
    await prisma.trial.deleteMany({ where: { learnerId: { in: lids } } });
    await prisma.booking.deleteMany({ where: { learnerId: { in: lids } } });
    await prisma.batchTiming.deleteMany({ where: { id: { in: created.timings } } });
    await prisma.classSession.deleteMany({ where: { id: { in: created.sessions } } });
    if (!created.todaySessionExisted) {
      await prisma.classSession.deleteMany({ where: { batchId: BATCH, sessionDate: todayDate } });
    }
    await prisma.guardianship.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await prisma.learner.deleteMany({ where: { id: { in: lids } } });
    await app?.close();
  });

  describe('family profiles', () => {
    it('rejects a child without guardian consent', async () => {
      const r = await call(varun.token, 'POST', '/family/learners', { name: 'Aarav', dob: '2016-05-01' });
      expect(r.status).toBe(400);
    });

    it('adds two children, with no standing attendance code', async () => {
      const a = await call(varun.token, 'POST', '/family/learners', { name: 'Aarav', dob: '2016-05-01', gender: 'male', consent: true });
      const b = await call(varun.token, 'POST', '/family/learners', { name: 'Anaya', dob: '2018-02-01', gender: 'female', consent: true });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      aarav = a.body.learner;
      anaya = b.body.learner;
      expect(a.body.learner).not.toHaveProperty('attendance_otp');
      const list = await call(varun.token, 'GET', '/family/learners');
      expect(list.body.learners.map((l: any) => l.is_self)).toEqual([true, false, false]);
    });

    it("hides one family's children from another (404)", async () => {
      expect((await call(other.token, 'GET', `/learners/${aarav.id}/attendance`)).status).toBe(404);
      expect((await call(other.token, 'PATCH', `/family/learners/${aarav.id}`, { name: 'X' })).status).toBe(404);
      expect((await call(other.token, 'DELETE', `/family/learners/${aarav.id}`)).status).toBe(404);
    });
  });

  describe('booking', () => {
    it("refuses a booking for another family's child", async (ctx) => {
      const { times } = await getTrialAvailability(BATCH);
      if (!times.length) ctx.skip();
      const r = await call(other.token, 'POST', '/bookings', { batch_id: BATCH, trial_at: times[0], learner_id: aarav.id });
      expect(r.status).toBe(404);
    });

    it('allows one trial per learner per batch, siblings separately', async (ctx) => {
      const { times } = await getTrialAvailability(BATCH);
      if (!times.length) ctx.skip();
      const first = await call(varun.token, 'POST', '/bookings', { batch_id: BATCH, trial_at: times[0], learner_id: aarav.id });
      expect(first.status).toBe(200);
      expect(first.body.booking.learner_id).toBe(aarav.id);
      // What payment capture does: the trial row follows the booking's learner.
      const b = await prisma.booking.findUniqueOrThrow({ where: { id: first.body.booking.id }, include: { batch: true } });
      await prisma.trial.create({
        data: { id: newId(), userId: b.userId, learnerId: b.learnerId, academyId: b.batch.academyId, batchId: b.batchId, bookingId: b.id, trialAt: b.trialAt! },
      });

      const again = await call(varun.token, 'POST', '/bookings', { batch_id: BATCH, trial_at: times[0], learner_id: aarav.id });
      expect(again.status).toBe(409);
      const sibling = await call(varun.token, 'POST', '/bookings', { batch_id: BATCH, trial_at: times[0], learner_id: anaya.id });
      expect(sibling.status).toBe(200);

      const mine = await call(varun.token, 'GET', '/trials/my');
      const t = mine.body.items.find((x: any) => x.learner_id === aarav.id);
      // The trial is in the future: no code yet, only when it appears.
      expect(t.attendance_code).toBeNull();
      expect(new Date(t.attendance_code_opens_at).getTime()).toBe(new Date(t.trial_at).getTime() - 60 * 60_000);
      expect((await call(other.token, 'GET', `/trials/${t.id}`)).status).toBe(404);
    });
  });

  describe('attendance register', () => {
    beforeAll(async () => {
      await enroll(varun.id, aarav.id);
      await enroll(varun.id, anaya.id);
      await enroll(ravi.id, ravi.learnerId);
    });

    it('lists siblings as separate rows with their parent', async () => {
      const r = await call(academyToken, 'GET', `/studio/batches/${BATCH}/session/attendance`, undefined, true);
      expect(r.status).toBe(200);
      expect(r.body.session_date).toBe(today);
      const mine = r.body.roster.filter((x: any) => x.user_id === varun.id);
      expect(mine.map((x: any) => x.name).sort()).toEqual(['Aarav', 'Anaya']);
      expect(mine.every((x: any) => x.guardian_name === 'Varun')).toBe(true);
    });

    it("hands the parent today's code for each child, and only to that parent", async () => {
      const enr = await prisma.enrollment.findFirstOrThrow({ where: { learnerId: aarav.id, batchId: BATCH } });
      const mine = await call(varun.token, 'GET', `/enrollments/${enr.id}/attendance-code`);
      expect(mine.status).toBe(200);
      expect(mine.body.code).toBe(codeFor(aarav.id));
      expect(mine.body.session_date).toBe(today);
      expect((await call(other.token, 'GET', `/enrollments/${enr.id}/attendance-code`)).status).toBe(404);
      // Siblings, and the same child on another day, have different codes.
      expect(codeFor(aarav.id)).not.toBe(codeFor(anaya.id));
    });

    it("accepts each child's own code and not a sibling's", async () => {
      const url = `/studio/batches/${BATCH}/session/mark`;
      expect((await call(academyToken, 'POST', url, { learner_id: anaya.id, otp_code: codeFor(aarav.id) }, true)).status).toBe(403);
      const ok = await call(academyToken, 'POST', url, { learner_id: aarav.id, otp_code: codeFor(aarav.id) }, true);
      expect(ok.status).toBe(200);
      expect(ok.body.learner_id).toBe(aarav.id);
    });

    it("maps an old academy build's user_id to the adult's own learner", async () => {
      const r = await call(academyToken, 'POST', `/studio/batches/${BATCH}/session/mark`, { user_id: ravi.id, otp_code: codeFor(ravi.learnerId) }, true);
      expect(r.status).toBe(200);
      expect(r.body.learner_id).toBe(ravi.learnerId);
    });

    it('records a mark without a code as manual, with the reason', async () => {
      const r = await call(
        academyToken,
        'PATCH',
        `/studio/batches/${BATCH}/sessions/${today}/attendance`,
        { learner_id: anaya.id, present: true, reason: 'No phone with them' },
        true,
      );
      expect(r.status).toBe(200);
      expect(r.body.method).toBe('manual');
      const row = await prisma.batchAttendance.findFirstOrThrow({ where: { learnerId: anaya.id, date: todayDate } });
      expect(row.reason).toBe('No phone with them');
    });

    it("shows a parent only their own child's history", async () => {
      const r = await call(varun.token, 'GET', `/learners/${aarav.id}/attendance`);
      expect(r.body.records).toHaveLength(1);
      expect(r.body.records[0].method).toBe('otp');
    });

    it('gives the academy learner rows, learner ids and a Parent column', async () => {
      const students = await call(academyToken, 'GET', `/studio/batches/${BATCH}/students`, undefined, true);
      const sibs = students.body.students.filter((s: any) => s.user_id === varun.id);
      expect(sibs).toHaveLength(2);
      expect(sibs.every((s: any) => s.id === s.learner_id && s.guardian_name === 'Varun')).toBe(true);

      const detail = await call(academyToken, 'GET', `/studio/students/${aarav.id}`, undefined, true);
      expect(detail.body.student).toMatchObject({ name: 'Aarav', guardian_name: 'Varun' });

      const csv = await call(academyToken, 'GET', `/studio/batches/${BATCH}/attendance.csv`, undefined, true);
      expect(csv.raw.split('\n')[0].startsWith('Student,Parent,')).toBe(true);
      expect(csv.raw).toMatch(/Aarav,Varun,/);
      expect(csv.raw).toMatch(/Ravi Adult,,/);
    });

    it('blocks archiving a child who is enrolled', async () => {
      expect((await call(varun.token, 'DELETE', `/family/learners/${aarav.id}`)).status).toBe(409);
    });
  });

  describe('session closer', () => {
    it('writes an absence per learner for a finished class', async (ctx) => {
      // A real class already on record for yesterday is not ours to close.
      if (await prisma.classSession.findUnique({ where: { batchId_sessionDate: { batchId: BATCH, sessionDate: yesterdayDate } } })) {
        ctx.skip();
      }
      // Yesterday: only Aarav was marked. Anaya and Ravi were expected too.
      const s = await prisma.classSession.create({ data: { batchId: BATCH, sessionDate: yesterdayDate, status: 'held' } });
      created.sessions.push(s.id);
      await prisma.batchAttendance.create({
        data: { batchId: BATCH, userId: varun.id, learnerId: aarav.id, date: yesterdayDate, present: true, method: 'otp' },
      });

      await closeFinishedSessions();

      const rows = await prisma.batchAttendance.findMany({
        where: { batchId: BATCH, date: yesterdayDate, learnerId: { in: [aarav.id, anaya.id, ravi.learnerId] } },
      });
      const byLearner = new Map(rows.map((r) => [r.learnerId, r]));
      expect(byLearner.get(aarav.id)?.present).toBe(true);
      expect(byLearner.get(anaya.id)).toMatchObject({ present: false, method: 'auto', userId: varun.id });
      expect(byLearner.get(ravi.learnerId)).toMatchObject({ present: false, method: 'auto', userId: ravi.id });
      expect((await prisma.classSession.findUniqueOrThrow({ where: { id: s.id } })).finalisedAt).not.toBeNull();
    });
  });
});
