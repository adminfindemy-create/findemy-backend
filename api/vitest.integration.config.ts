import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.ts', 'test/integration/**/*.test.ts'],
    // The database tests share one DB and clean up after themselves; run files one at a time.
    fileParallelism: false,
    // See vitest.config.ts — tests never boot server.ts, so .env must be loaded here.
    setupFiles: ['dotenv/config'],
    testTimeout: 30000,
  },
});
