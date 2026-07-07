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

/** A workshop is refundable only if cancelled more than this many hours before it starts. */
export const WORKSHOP_REFUND_MIN_HOURS = 24;

/** How many weeks of upcoming trial datetimes to project from a batch's timings. */
export const TRIAL_AVAILABILITY_WEEKS = 2;
