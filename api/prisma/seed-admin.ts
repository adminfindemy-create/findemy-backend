// Seeds the first Findemy Ops Console admin into the AdminUser allowlist (idempotent).
//
// Usage:
//   pnpm tsx prisma/seed-admin.ts                      # seeds ADMIN_EMAIL / ADMIN_NAME (or the defaults)
//   ADMIN_EMAIL=you@findemy.com pnpm tsx prisma/seed-admin.ts
//
// A row here is REQUIRED for login: a valid admin sign-in needs both a Google Workspace token
// (hd == Findemy domain) AND an enabled AdminUser row with the matching email. In MOCK mode the
// dev login accepts an email directly, still checked against this allowlist.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL || 'admin.findemy@gmail.com').toLowerCase();
  const name = process.env.ADMIN_NAME || 'Findemy Admin';

  const admin = await prisma.adminUser.upsert({
    where: { email },
    create: { email, name },
    update: { disabled: false },
  });

  console.log(`[seed-admin] admin ready: ${admin.email} (id=${admin.id}, disabled=${admin.disabled})`);
}

main()
  .catch((err) => {
    console.error('[seed-admin] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
