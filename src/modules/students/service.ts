import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';

export async function getStudents(academyId: string, q?: string) {
  const where: Record<string, unknown> = { batch: { academyId } };
  if (q) {
    where.user = { name: { contains: q, mode: 'insensitive' } };
  }
  const enrollments = await prisma.enrollment.findMany({
    where,
    take: 20,
    include: {
      user: { select: { id: true, name: true, phone: true, age: true } },
      batch: { select: { title: true } },
    },
  });

  const userMap = new Map();
  for (const e of enrollments) {
    if (!userMap.has(e.userId)) {
      userMap.set(e.userId, {
        id: e.userId,
        name: e.user.name,
        phone: e.user.phone,
        age: e.user.age,
        batches: [],
        status: 'active',
      });
    }
    userMap.get(e.userId).batches.push(e.batch.title);
  }
  return { items: Array.from(userMap.values()), next_cursor: null };
}

export async function getStudent(userId: string, academyId: string) {
  const enrollments = await prisma.enrollment.findMany({
    where: { userId, batch: { academyId } },
    include: { batch: { select: { title: true } } },
  });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, phone: true, age: true },
  });
  if (!user) throw new AppError('NOT_FOUND', 404, 'Student not found');

  const attendance = await prisma.batchAttendance.findMany({
    where: { userId, batch: { academyId } },
    orderBy: { date: 'desc' },
    take: 30,
  });

  return {
    student: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      age: user.age,
      batches: enrollments.map((e) => e.batch.title),
      status: 'active',
    },
    attendance_history: attendance.map((a) => ({
      date: a.date.toISOString().slice(0, 10),
      present: a.present,
    })),
  };
}
