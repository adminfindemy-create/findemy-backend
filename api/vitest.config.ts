import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `src/server.ts` loads .env via `import 'dotenv/config'`, but tests build the app
    // directly and never go through server.ts — so anything importing `src/lib/env.ts`
    // blew up on the zod parse (DATABASE_URL/REDIS_URL/JWT_* "Required"). Same loader,
    // applied before the suite instead of at server boot.
    setupFiles: ['dotenv/config'],
    // Database tests write real rows; they run only via `test:integration`.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
  },
});
