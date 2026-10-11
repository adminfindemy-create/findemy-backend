import { reconcilePayouts } from '../modules/settlement/payout.js';

// Mirrors refund-reconcile: settles `processing` payouts to paid/failed. Mock RazorpayX ids
// (pout_mock_*) resolve to paid + a mock UTR; real ids are settled by the payout.* webhook.
export async function reconcileProcessingPayouts() {
  return reconcilePayouts();
}
