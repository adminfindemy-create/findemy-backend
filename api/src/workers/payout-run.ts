import { previousPeriod, runPayouts } from '../modules/settlement/payout.js';

// Weekly cron (Sunday 00:00). Computes the just-ended week into `pending`/`skipped` Payout rows.
// Creates the reviewable batch only — no money moves until an admin approves.
export async function runWeeklyPayouts() {
  const { periodStart, periodEnd } = previousPeriod(new Date());
  return runPayouts(periodStart, periodEnd);
}
