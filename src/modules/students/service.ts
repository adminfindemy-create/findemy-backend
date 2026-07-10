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

  // A student can have multiple enrollments (one per batch), so collapse rows into one
  // entry per student with a list of their batch titles.
  const studentByUserId = new Map();
  for (const enrollment of enrollments) {
    if (!studentByUserId.has(enrollment.userId)) {
      studentByUserId.set(enrollment.userId, {
        id: enrollment.userId,
        name: enrollment.user.name,
        phone: enrollment.user.phone,
        age: enrollment.user.age,
        batches: [],
        status: 'active',
      });
    }
    studentByUserId.get(enrollment.userId).batches.push(enrollment.batch.title);
  }
  return { items: Array.from(studentByUserId.values()), next_cursor: null };
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
      batches: enrollments.map((enrollment) => enrollment.batch.title),
      status: 'active',
    },
    attendance_history: attendance.map((record) => ({
      date: record.date.toISOString().slice(0, 10),
      present: record.present,
    })),
  };
}
