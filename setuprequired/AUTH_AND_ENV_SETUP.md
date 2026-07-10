# Findemy API — Authentication, Required Keys & Bypass Report

Scope: `backend/api` (Fastify + Prisma), the single service behind **both** the student app and
the academy/admin app. Everything below was verified by reading the current source in this
repo — not assumed. Companion docs: `SECURITY_AUDIT.md` (deeper narrative on the same findings)
and `GCP_DEPLOYMENT.md` (step-by-step provider signup + infra). This file is the one-stop answer
to "how does auth work, what keys do I need, how do I generate them safely, and what's broken."

---

## 1. Authentication methods in use

All three login paths converge on the same token-issuance code (`issueTokens` in
`src/modules/auth/service.ts`).

### 1.1 Phone OTP (primary, both apps)
- `POST /auth/otp/request` — `{ phone, role: 'student'|'academy' }`. Generates a 6-digit code
  (`generateOtpCode`, `src/lib/otp.ts`), stores only its SHA-256 hash (`hashOtp`), 5-minute TTL.
- `POST /auth/otp/verify` — `{ otp_id, code }`. Max 5 attempts per `otp_id`; the code is compared
  via `compareOtpHash`, which hashes the input and uses `crypto.timingSafeEqual` (with a
  length check first) to avoid timing side-channels. On success it looks up/creates the
  user or academy account by phone and issues tokens.
- SMS delivery is meant to go through **MSG91**. In dev (`MOCK=1`, or `MSG91_AUTH_KEY` unset),
  `requestOtp` just `console.log`s the code (`src/modules/auth/service.ts:44-46`) instead of
  sending SMS — fine for local dev, a real gap if it happens in production (see §2, `MSG91_AUTH_KEY`).

### 1.2 Sign in with Apple / Google (both apps)
- `POST /auth/oauth/apple` / `POST /auth/oauth/google` — client sends the provider's `idToken`
  (+ `nonce` for Apple) and `role`.
- Verified server-side against the provider's **live JWKS** via `jose`
  (`src/modules/auth/oauth/{apple,google}-verifier.ts`):
  - Google: issuer pinned to `accounts.google.com`, audience checked against role-specific
    client IDs (`GOOGLE_STUDENT_*` vs `GOOGLE_ADMIN_*`).
  - Apple: issuer pinned to `appleid.apple.com`, audience checked against the role-specific
    bundle ID (`APPLE_STUDENT_BUNDLE_ID` vs `APPLE_ADMIN_BUNDLE_ID`), plus Apple's
    SHA-256 nonce-hash convention.
  - Both map expired / audience-mismatch / issuer-mismatch / unreachable-JWKS to distinct error
    codes. This part is solid — confirmed no bypass.
- First sign-in creates a user/academy account and links the OAuth `sub`; later sign-ins match
  by `sub`, falling back to matching by verified email.

### 1.3 Session tokens (issued by both flows above)
- **Access token**: JWT, `ES256` (ECDSA P-256), 15-minute expiry, signed/verified with
  `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (`src/lib/tokens.ts`). Payload: `{ sub, role, academy_id? }`.
- **Refresh token**: opaque 32-byte random value (`crypto.randomBytes`), not a JWT — only its
  SHA-256 hash is stored (`RefreshToken` table), 30-day expiry. `POST /auth/refresh` rotates it
  (old hash revoked, new one issued) with real **replay detection**: presenting an
  already-revoked refresh token revokes *every* refresh token for that subject
  (`src/modules/auth/service.ts:386-393`).
- **Check-in token**: separate short-lived (4h) `ES256` JWT scoped to `{batch_id, session_date}`,
  encoded into the academy's attendance QR (`signCheckinToken`/`verifyCheckinToken`). It only
  proves "this is today's session" — the scanning student's own bearer token still supplies
  identity.
- **Route guard**: `app.requireAuth(role?)` (`src/plugins/auth.ts`) verifies the bearer JWT and
  optionally enforces `role === 'student'|'academy'`.

### 1.4 Student vs. academy (admin) separation
There is no separate admin API — one server, distinguished entirely by the `role` claim in the
JWT and by separate OAuth client IDs / bundle IDs per app. `req.user.academy_id` is attached for
academy-role tokens, and academy-facing service functions scope their Prisma queries by it.

---

## 2. Required environment variables

Source of truth: `src/lib/env.ts` (the Zod schema actually validated at process boot — anything
not in this schema is silently ignored even if present in `.env`), cross-checked against
`backend/api/.env.example`.

### Hard-required — process throws at boot if missing
| Variable | Used for |
|---|---|
| `NODE_ENV` | runtime mode (`development` \| `production` \| `test`), defaults to `development` |
| `PORT` | HTTP port, defaults to `8080` |
| `MOCK` | `'1'` enables mock route responses for tests/local dev — **must be `0`/unset in production** |
| `DATABASE_URL` | Postgres connection string (Prisma) |
| `REDIS_URL` | BullMQ job queues |
| `JWT_PRIVATE_KEY` | signs access + check-in tokens (ES256) |
| `JWT_PUBLIC_KEY` | verifies access + check-in tokens |

### Optional in the Zod schema, but load-bearing for real features
| Variable | Used for | Behavior if absent |
|---|---|---|
| `MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID` | SMS OTP delivery | OTP code only printed to server logs (`src/modules/auth/service.ts:44-46`) — no SMS sent |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | payment order creation | orders created with a fake local `order_...` id, no real Razorpay order (`src/modules/payments/service.ts:66-77`) |
| `RAZORPAY_WEBHOOK_SECRET` | verifies `/payments/webhook` signatures | **signature check is skipped entirely** — see Finding B |
| `HMS_ACCESS_KEY` / `HMS_SECRET` | reserved for 100ms SDK use | not currently read for a live call path beyond management token flows |
| `HMS_MANAGEMENT_TOKEN` | 100ms room/token creation | `generateHmsToken` returns `'mock-token'`, `createHmsRoom` returns `null` (mock room = batch id) |
| `HMS_TEMPLATE_ID` | 100ms room creation | `createHmsRoom` short-circuits to `null` (mock room) |
| `HMS_WEBHOOK_SECRET` | verifies `/rooms/100ms/webhook` | **signature check is skipped entirely** — see Finding C |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Cloudflare R2 media storage | falls back to local disk storage |
| `GOOGLE_GEOCODING_KEY` | address → lat/lng | geocoding calls fail/no-op |
| `EXPO_ACCESS_TOKEN` | push notification delivery via Expo | push sends fail/no-op |
| `SENTRY_DSN` | error tracking | no error reporting |
| `APPLE_STUDENT_BUNDLE_ID` / `APPLE_ADMIN_BUNDLE_ID` | Apple Sign-In audience, per app | Apple login for that role throws `oauth_audience_mismatch` (fails closed — safe default) |
| `GOOGLE_STUDENT_IOS_CLIENT_ID` / `GOOGLE_STUDENT_ANDROID_CLIENT_ID` | Google Sign-In audience, student app | same — fails closed if unset |
| `GOOGLE_ADMIN_IOS_CLIENT_ID` / `GOOGLE_ADMIN_ANDROID_CLIENT_ID` | Google Sign-In audience, admin app | same — fails closed if unset |

"Optional" per the Zod schema does **not** mean safe to omit in production. `GCP_DEPLOYMENT.md`
already documents all of the above as effectively required for a real launch — the gap (see §4)
is that the webhook secrets specifically degrade to "trust everything" instead of "refuse
traffic" when left unset, which is the opposite of every other optional var's fail-closed/mock
behavior.

---

## 3. Secure generation & storage

**General rule for all of these:** generate a distinct value per environment (dev/staging/prod),
inject at deploy time from a secret manager (GCP Secret Manager, AWS Secrets Manager, Vault,
etc.) as env vars — never bake into a Docker image or pass through plain `--set-env-vars` in CI
logs — and never commit real values. Only `.env.example` (placeholders) should ever be tracked.

- **`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`** — generate your own EC P-256 keypair, don't reuse any
  placeholder or example value:
  ```bash
  openssl ecparam -name prime256v1 -genkey -noout -out private.pem
  openssl ec -in private.pem -pubout -out public.pem
  ```
  Store the PEM contents (including newlines) as secrets, e.g.
  `gcloud secrets create jwt-private-key --data-file=private.pem`, then delete the local files.
  Rotating this key invalidates every outstanding access/refresh session at once — rotate
  deliberately (e.g. a planned forced re-login), not routinely.
- **`MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID`** — MSG91 dashboard (API section / SMS → Templates);
  needs DLT registration for India SMS. Treat the auth key as a bearer credential.
- **`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`** — Settings → API Keys in the Razorpay dashboard.
  Use `rzp_test_...` keys outside prod. The secret is shown once — capture it into your secret
  manager immediately.
- **`RAZORPAY_WEBHOOK_SECRET`** — this is a value *you* choose when configuring the webhook
  (Settings → Webhooks), not one Razorpay generates for you: `openssl rand -hex 32`, set the
  same value in Razorpay's dashboard and in every environment that exposes `/payments/webhook`.
- **`HMS_ACCESS_KEY` / `HMS_SECRET` / `HMS_MANAGEMENT_TOKEN` / `HMS_TEMPLATE_ID`** — 100ms
  dashboard → Developer → API Keys.
- **`HMS_WEBHOOK_SECRET`** — same pattern as the Razorpay webhook secret: your own
  `openssl rand -hex 32` value, configured to match on both sides.
- **`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`** — Cloudflare dashboard → R2 →
  Manage API Tokens. Scope the token to **Object Read & Write on the specific bucket only**.
- **`GOOGLE_GEOCODING_KEY`** — GCP Console → Credentials → API Key. Restrict to the Geocoding
  API and, if possible, your server's egress IP — an unrestricted Maps key is a common billing-abuse target if leaked.
- **`EXPO_ACCESS_TOKEN`** — expo.dev account settings → Access Tokens. One token per environment
  so prod can be revoked independently of staging.
- **`SENTRY_DSN`** — project settings in Sentry; not a secret in the traditional sense (DSNs are
  meant to be embedded in clients) but still keep per-environment so events don't cross-pollute.
- **`APPLE_*_BUNDLE_ID` / `GOOGLE_*_CLIENT_ID`** — identifiers, not shared secrets (they appear
  client-side too), but they gate which audiences your server accepts — keep student and admin
  values distinct, as they are now, since merging them would let an admin-app token pass as a
  student-app token or vice versa.
- **`DATABASE_URL` / `REDIS_URL`** — strong, generated passwords (not the `docker-compose.yml`
  dev password anywhere shared/staging), private networking (VPC / Cloud SQL proxy) over public
  exposure.

For the full provider-by-provider signup walkthrough (screenshots-level detail for MSG91,
Razorpay, 100ms, R2, Google, Apple, Expo, Sentry) see `GCP_DEPLOYMENT.md` §9–13 — this section
intentionally doesn't duplicate that.

---

## 4. Bypasses / weaknesses found (not fixed — for your team to apply)

Ranked by severity. Findings A–F were previously catalogued in `SECURITY_AUDIT.md`; I re-verified
every one against the current code in this session (all still reproducible) and add one new
finding (G) below that the earlier audit didn't cover.

### Finding A — IDOR: any authenticated student can read any other user's payment record
- **File:** `src/modules/payments/routes.ts:25-28`, `src/modules/payments/service.ts:299-315`
- **What's wrong:** `GET /payments/:id` is behind `requireAuth('student')`, but the handler calls
  `service.getPayment(id)` — it never passes `req.user.id`, and `getPayment` never filters by
  caller. Any logged-in student can fetch any payment by ID, exposing `razorpay_order_id`,
  `razorpay_payment_id`, amount, and status for a payment that isn't theirs.
- **How to resolve:** change the route to call `service.getPayment(id, req.user.id)`; have
  `getPayment` join through to the booking/enrollment and verify ownership (mirror
  `findBookingByIdAndUser`/`findEnrollmentByIdAndUser`, which already do this correctly
  elsewhere), throwing `NOT_FOUND` on mismatch rather than leaking existence via `403`.

### Finding B — Razorpay webhook signature check silently skipped when the secret isn't configured
- **File:** `src/modules/payments/service.ts:101-112`
- **What's wrong:** `const secret = env.RAZORPAY_WEBHOOK_SECRET || ''; if (secret) { ...verify... }`.
  If the secret is unset (the default in `.env.example`, and the schema marks it optional), the
  entire signature check is skipped and `handleWebhook` trusts the payload — anyone who can reach
  the endpoint can POST a fabricated `payment.captured` event and get a booking/enrollment marked
  paid for free. Separately, even when the secret *is* set, line 109 calls
  `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))` **without checking
  buffer lengths first** — a signature header of a different byte length throws instead of
  failing the check, unlike the HMS webhook handler (Finding C), which does check length first.
- **How to resolve:** fail closed — reject (401) whenever `RAZORPAY_WEBHOOK_SECRET` isn't
  configured and the app isn't explicitly in mock/dev mode. Add a
  `signature.length === expected.length` guard (or wrap in try/catch) before calling
  `timingSafeEqual`, matching the pattern already used correctly in the HMS handler.

### Finding C — 100ms webhook signature check has the same "fail open" bug
- **File:** `src/modules/rooms/service.ts:101-108`
- **What's wrong:** identical shape to Finding B — `const secret = env.HMS_WEBHOOK_SECRET || '';
  if (secret) { ...verify... }`. With the secret unset, `POST /rooms/100ms/webhook` accepts any
  payload unverified. Since the handler resolves `(room_id, user_id)` from the body and calls
  `attendanceRepo.recordPresent(userId, batch.id, ...)`, an attacker who knows/guesses a
  `room_id` (batch IDs double as mock room IDs per `ensureLiveRoom`) and any `user_id` can mark
  arbitrary students "present" for a live session without joining — affecting attendance tiers
  and refund eligibility.
- **How to resolve:** same as Finding B — require `HMS_WEBHOOK_SECRET` to be present and reject
  (401) if missing outside mock mode, instead of silently trusting the payload.

### Finding D — CORS reflects any origin while allowing credentials
- **File:** `src/plugins/cors.ts:5-9`
- **What's wrong:** `cors` is registered with `{ origin: true, credentials: true }`. `origin:
  true` makes `@fastify/cors` reflect whatever `Origin` header the caller sends, and
  `credentials: true` tells browsers cross-origin requests may include credentials. Since this
  API authenticates via `Authorization: Bearer` headers (confirmed, not cookies), practical
  exploitability is lower than a cookie-based session — but a script on any third-party site can
  still make authenticated cross-origin requests using a token obtained some other way (XSS
  elsewhere, a malicious SDK, a leaked token), and this is the first thing most security scanners
  flag.
- **How to resolve:** replace `origin: true` with an explicit allow-list (student app web origin,
  admin app web origin, known local-dev origins), or drop `credentials: true` entirely since no
  cookie-based flow needs it here.

### Finding E — No rate limiting on OTP request
- **File:** `src/modules/auth/routes.ts:54-57` → `src/modules/auth/service.ts` (`requestOtp`)
- **What's wrong:** `POST /auth/otp/request` has no per-phone or per-IP throttle
  (`@fastify/rate-limit` isn't installed; nothing custom is wired into `app.ts` or this route).
  Only `verify` caps wrong-code attempts at 5 — `request` itself can be called unlimited times
  for the same phone number, enabling SMS-bombing (MSG91 cost abuse + harassment vector).
- **How to resolve:** add a rate limiter in front of this route — `@fastify/rate-limit` scoped to
  it, or a Redis-backed counter keyed on phone (and/or IP) with a short window (e.g. 3 requests /
  10 minutes) — Redis is already a dependency here.

### Finding F — No global security headers or app-level rate limiting
- **File:** `src/app.ts`
- **What's wrong:** the only plugins registered are error-handling, CORS, auth, mock, and
  multipart — no `@fastify/helmet` (standard headers like `X-Content-Type-Options`,
  `Strict-Transport-Security`) and no app-wide rate limiter as defense-in-depth beyond Finding E's
  specific gap.
- **How to resolve:** register `@fastify/helmet` and a conservative global `@fastify/rate-limit`
  in `buildApp()`, tuned so it doesn't interfere with legitimate polling/webhook traffic.

### Finding G — `.env.development` holds real-looking secrets and isn't gitignored
- **File:** `backend/api/.env.development`, `backend/api/.gitignore`
- **What's wrong:** `.gitignore` only lists `.env` and `.env.local` (confirmed by reading it) —
  it does **not** cover `.env.development`. That file currently contains what appears to be a
  real generated EC private/public keypair for `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`, and a
  `DATABASE_URL` with a plaintext password pointed at what looks like a real GCP Cloud SQL
  instance (`/cloudsql/findemy-dev:...`). `git status` currently shows this file as untracked
  (`??`), so it hasn't been committed *yet* — but it is one `git add -A` / `git add .` away from
  landing in history, at which point rotation wouldn't be optional (removing a file from the
  working tree doesn't remove it from git history).
- **How to resolve:** add `.env.development` to `.gitignore` (a broader `.env*` pattern with an
  explicit `!.env.example` allow-line is more robust than enumerating filenames one at a time).
  Given this key has been sitting in a non-ignored file, treat it as potentially exposed —
  rotate the JWT keypair and the DB password shown in that file, and confirm with `git log --all
  -- backend/api/.env.development` that it never actually made it into a commit before/after
  this fix (it hadn't, as of this audit).

---

## 5. What's already solid (so it isn't re-litigated later)

- OTP codes and refresh tokens are stored hashed, never in plaintext; OTP comparison uses a
  length check + `timingSafeEqual`.
- Refresh-token rotation has real replay detection (reuse of a revoked token nukes all sessions
  for that subject).
- OAuth verification correctly pins issuer + audience per provider and per app (student vs
  admin), with distinct, accurately-mapped error codes for expired/audience-mismatch/
  issuer-mismatch/unreachable-JWKS. Missing Apple/Google client ID config fails **closed**
  (`oauth_audience_mismatch`), unlike the webhook secrets in Findings B/C.
  Every academy-facing (admin) route consistently scopes queries by the caller's own
  `academy_id` — no cross-academy IDOR found there.
- `.env` itself is correctly gitignored and confirmed absent from git history — the gap is
  specifically `.env.development` (Finding G).
