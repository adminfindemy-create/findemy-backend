import { prisma } from '../lib/prisma.js';

export async function sweepExpiredOtps() {
  const deleted = await prisma.otpRequest.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return { deleted: deleted.count };
}
