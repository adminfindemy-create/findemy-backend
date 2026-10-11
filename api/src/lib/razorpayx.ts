// RazorpayX is a SEPARATE money rail from Razorpay orders/refunds — it moves money OUT to
// academies (Contact → FundAccount → Payout/Transfer). It needs its own keys. When those are
// absent (local/MOCK), every call returns a deterministic `*_mock_*` id, mirroring how
// `issueRazorpayRefund` degrades. The real HTTP path is implemented but never hit in MOCK.
import { newId } from './id.js';

const RZPX_BASE = 'https://api.razorpay.com/v1';

function hasKeys(): boolean {
  return (
    process.env.MOCK !== '1' &&
    !!process.env.RAZORPAY_KEY_ID &&
    !!process.env.RAZORPAY_KEY_SECRET
  );
}

function mockId(prefix: string): string {
  return `${prefix}_mock_${newId().slice(0, 12)}`;
}

async function rzpxPost<T>(path: string, body: unknown): Promise<T> {
  const auth = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
  ).toString('base64');
  const res = await fetch(`${RZPX_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RazorpayX ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

// Create a RazorpayX Contact for an academy (the payee entity).
export async function createContact(args: {
  name: string;
  email?: string;
  referenceId: string; // academyId, for idempotency/traceability
}): Promise<{ id: string }> {
  if (!hasKeys()) return { id: mockId('cont') };
  return rzpxPost<{ id: string }>('/contacts', {
    name: args.name,
    email: args.email,
    type: 'vendor',
    reference_id: args.referenceId,
  });
}

// Create a bank FundAccount under a Contact (where transfers land).
export async function createFundAccount(args: {
  contactId: string;
  accountNumber: string;
  ifsc: string;
  holderName: string;
}): Promise<{ id: string }> {
  if (!hasKeys()) return { id: mockId('fa') };
  return rzpxPost<{ id: string }>('/fund_accounts', {
    contact_id: args.contactId,
    account_type: 'bank_account',
    bank_account: {
      name: args.holderName,
      ifsc: args.ifsc,
      account_number: args.accountNumber,
    },
  });
}

// Fire a RazorpayX Payout (money out) to a FundAccount. Returns the transfer/payout id.
export async function createPayout(args: {
  fundAccountId: string;
  amountPaise: number;
  referenceId: string; // Payout.id, for idempotency
}): Promise<{ id: string; status: string }> {
  if (!hasKeys()) return { id: mockId('pout'), status: 'processing' };
  return rzpxPost<{ id: string; status: string }>('/payouts', {
    fund_account_id: args.fundAccountId,
    amount: args.amountPaise,
    currency: 'INR',
    mode: 'IMPS',
    purpose: 'payout',
    reference_id: args.referenceId,
    queue_if_low_balance: true,
  });
}
