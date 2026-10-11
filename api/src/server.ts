import 'dotenv/config';
import { buildApp } from './app.js';
import { env } from './lib/env.js';
import { startTrialReminderJob } from './jobs/trialReminder.js';

async function main() {
  const app = await buildApp();
  const port = Number(env.PORT);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Server listening on http://0.0.0.0:${port}`);
  startTrialReminderJob();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
