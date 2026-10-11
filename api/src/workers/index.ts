import { Queue, Worker } from 'bullmq';
import { env } from '../lib/env.js';
import { sweepExpiredOtps } from './otp-sweeper.js';
import { releaseExpiredReservations } from './slot-ttl.js';
import { sendTrialReminders } from './trial-reminder.js';
import { closeMissedTrials } from './attendance-close.js';
import { retryFailedWebhooks } from './webhook-retry.js';
import { runEnrollmentLifecycle } from './enrollment-lifecycle.js';
import { sendRenewalReminders } from './renewal-reminder.js';
import { reconcileStaleRefunds } from './refund-reconcile.js';
import { sendClassReminders } from './class-reminder.js';
import { closeFinishedSessions } from './session-close.js';
import { releaseMaturedReserves } from './reserve-release.js';
import { runWeeklyPayouts } from './payout-run.js';
import { reconcileProcessingPayouts } from './payout-reconcile.js';

const redisConnection = { url: env.REDIS_URL };

const queues = {
  'otp-sweeper': new Queue('otp-sweeper', { connection: redisConnection }),
  'slot-ttl': new Queue('slot-ttl', { connection: redisConnection }),
  'trial-reminder': new Queue('trial-reminder', { connection: redisConnection }),
  'attendance-close': new Queue('attendance-close', { connection: redisConnection }),
  'webhook-retry': new Queue('webhook-retry', { connection: redisConnection }),
  'enrollment-lifecycle': new Queue('enrollment-lifecycle', { connection: redisConnection }),
  'renewal-reminder': new Queue('renewal-reminder', { connection: redisConnection }),
  'refund-reconcile': new Queue('refund-reconcile', { connection: redisConnection }),
  'class-reminder': new Queue('class-reminder', { connection: redisConnection }),
  'session-close': new Queue('session-close', { connection: redisConnection }),
  'reserve-release': new Queue('reserve-release', { connection: redisConnection }),
  'payout-run': new Queue('payout-run', { connection: redisConnection }),
  'payout-reconcile': new Queue('payout-reconcile', { connection: redisConnection }),
};

function createWorker(name: string, processor: () => Promise<unknown>) {
  return new Worker(
    name,
    async () => {
      console.log(`[worker:${name}] starting...`);
      const result = await processor();
      console.log(`[worker:${name}] done`, result);
      return result;
    },
    { connection: redisConnection },
  );
}

export function startWorkers() {
  createWorker('otp-sweeper', sweepExpiredOtps);
  createWorker('slot-ttl', releaseExpiredReservations);
  createWorker('trial-reminder', sendTrialReminders);
  createWorker('attendance-close', closeMissedTrials);
  createWorker('webhook-retry', retryFailedWebhooks);
  createWorker('enrollment-lifecycle', runEnrollmentLifecycle);
  createWorker('renewal-reminder', sendRenewalReminders);
  createWorker('refund-reconcile', reconcileStaleRefunds);
  createWorker('class-reminder', sendClassReminders);
  createWorker('session-close', closeFinishedSessions);
  createWorker('reserve-release', releaseMaturedReserves);
  createWorker('payout-run', runWeeklyPayouts);
  createWorker('payout-reconcile', reconcileProcessingPayouts);

  console.log('[workers] all started');
}

export async function scheduleJobs() {
  await queues['otp-sweeper'].add('sweep', {}, { repeat: { pattern: '*/5 * * * *' } });
  await queues['slot-ttl'].add('release', {}, { repeat: { pattern: '*/2 * * * *' } });
  await queues['trial-reminder'].add('remind', {}, { repeat: { pattern: '*/5 * * * *' } });
  await queues['attendance-close'].add('close', {}, { repeat: { pattern: '0 * * * *' } });
  await queues['webhook-retry'].add('retry', {}, { repeat: { pattern: '*/10 * * * *' } });
  await queues['enrollment-lifecycle'].add('lifecycle', {}, { repeat: { pattern: '0 * * * *' } });
  await queues['renewal-reminder'].add('remind', {}, { repeat: { pattern: '30 3 * * *' } }); // 09:00 IST
  await queues['refund-reconcile'].add('reconcile', {}, { repeat: { pattern: '*/30 * * * *' } });
  await queues['class-reminder'].add('remind', {}, { repeat: { pattern: '*/15 * * * *' } });
  // Every 5 min: absences land within ~5 min of the 15-min close, so the record is current while
  // the academy is still in the studio.
  await queues['session-close'].add('close', {}, { repeat: { pattern: '*/5 * * * *' } });
  await queues['reserve-release'].add('release', {}, { repeat: { pattern: '0 4 * * *' } }); // daily
  await queues['payout-run'].add('run', {}, { repeat: { pattern: '0 0 * * 0' } }); // weekly, Sunday 00:00
  await queues['payout-reconcile'].add('reconcile', {}, { repeat: { pattern: '*/30 * * * *' } });
  console.log('[workers] cron schedules added');
}

// Auto-start when this module is loaded directly (not in tests)
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startWorkers();
  scheduleJobs().catch((err: unknown) => {
    console.error('[workers] failed to schedule jobs', err);
  });
}
