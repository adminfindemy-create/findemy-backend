// Backend business-policy tunables (P2). NEVER shipped to the app bundle — backend-only.
// Shared contract constants (plan months, discount cap, OTP lengths) live in @findemy/types.
//
// Centralised so these are easy to find and change. Ops-tunable values read from env with a
// default, so they can change without a code deploy.

/** Findemy's commission on captured trials + enrolments, in basis points.
 *  Default 1500 = 15% (confirmed with the owner; change via the COMMISSION_BPS env var). */
export const COMMISSION_BPS = Number(process.env.COMMISSION_BPS ?? 1500);

/** A paid trial is refundable only if cancelled at least this many hours before it starts. */
export const TRIAL_REFUND_MIN_HOURS = 4;

/** A workshop registration is refundable only if cancelled at least this many hours before the
 *  workshop starts; within the window it is non-refundable. (Policy set 2026-07-09, superseding
 *  the earlier "workshops are never refundable" rule.) */
export const WORKSHOP_REFUND_MIN_HOURS = 24;

/**
 * How far ahead a renewal counts as "due soon" on the academy side.
 *
 * 7 matches the FIRST student-facing reminder in `workers/renewal-reminder.ts` (7 / 3 / 1), so
 * the academy sees a renewal from the same moment the student is first told about it — rather
 * than finding out only once it lapses.
 */
export const DUES_SOON_DAYS = 7;

/** Per-transaction ceiling on an admin (Support 360) refund. A single refund cannot exceed this,
 *  independent of the payment amount. Default 5,000,000 paise (₹50,000). Tunable via env. */
export const ADMIN_REFUND_CAP_PAISE = Number(process.env.ADMIN_REFUND_CAP_PAISE ?? 5_000_000);

/** How many weeks of upcoming trial datetimes to project from a batch's timings. */
export const TRIAL_AVAILABILITY_WEEKS = 2;

/** Minimum net payout to actually disburse in a weekly run. Below this, the row is `skipped`
 *  and its positive net carries forward into the next period. Default 10000 paise (₹100). */
export const MIN_PAYOUT_PAISE = Number(process.env.MIN_PAYOUT_PAISE ?? 10000);

/** Rolling reserve rate withheld from captured revenue, in basis points (mirrors the academy
 *  default `reserveRateBps`). 1000 = 10%. Used only for display/derivation in the payout engine. */
export const RESERVE_RATE_BPS = Number(process.env.RESERVE_RATE_BPS ?? 1000);
