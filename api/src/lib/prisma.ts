import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Only connect eagerly when not in mock/test mode
if (process.env.MOCK !== '1' && process.env.NODE_ENV !== 'test') {
  prisma.$connect().catch((err: unknown) => {
    logger.error({ err }, 'Prisma connection failed');
    process.exit(1);
  });
}
