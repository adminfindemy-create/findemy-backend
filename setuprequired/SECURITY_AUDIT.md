# Findemy API — Authentication, Secrets & Security Audit

Scope: `backend/api` (Fastify + Prisma), which serves **both** the student app and the academy/admin app from a single API. Findings below come from reading the actual source (not assumptions) as of this audit. This file is deliberately **not** wired into deployment automation — it's a reference for the team.

---

## 1. Authentication methods in use

The API supports three ways to log in, all converging on the same token issuance path (`issueTokens` in `src/modules/auth/service.ts`):

### 1.1 Phone OTP (primary, both apps)
- `POST /auth/otp/request` — `{ phone, role: 'student' | 'academy' }`. Generates a 6-digit code (`generateOtpCode`, `src/lib/otp.ts`), stores only its SHA-256 hash (`hashOtp`), 5-minute TTL.
- `POST /auth/otp/verify` — `{ otp_id, code }`. Max 5 attempts per `otp_id`; compares via `timingSafeEqual` (`compareOtpHash`) to avoid timing leaks. On success, creates/looks up the user or academy account by phone and issues tokens.
- SMS delivery goes through **MSG91**. In dev (`MOCK=1` or no `MSG91_AUTH_KEY`), the code is only printed to the server console (`src/modules/auth/service.ts:44-46`) — actual MSG91 send integration for production isn't in this file (see §4 for the gap this implies operationally, not a code bypass).

### 1.2 Sign in with Apple / Google (both apps)
- `POST /auth/oauth/apple` and `POST /auth/oauth/google` — client sends the provider's `idToken` (+ optional `nonce` for Apple) and `role`.
- Verification is done server-side against the provider's live JWKS (`src/modules/auth/oauth/{apple,google}-verifier.ts`), using the `jose` library:
  - Google: issuer pinned to `accounts.google.com`, audience checked against **role-specific** client IDs (`GOOGLE_STUDENT_*` vs `GOOGLE_ADMIN_*`).
  - Apple: issuer pinned to `appleid.apple.com`, audience checked against the **role-specific bundle ID** (`APPLE_STUDENT_BUNDLE_ID` vs `APPLE_ADMIN_BUNDLE_ID`), plus Apple's nonce-hash convention.
  - Both reject expired tokens, audience/issuer mismatches, and unreachable JWKS with distinct, correctly-mapped error codes. This part is solid — no bypass found.
- First-time sign-in creates a user/academy account and links the OAuth `sub`; subsequent sign-ins match by `sub`, falling back to matching by verified email.

### 1.3 Session tokens (issued by both flows above)
- **Access token**: JWT, `ES256` (ECDSA P-256), 15-minute expiry, signed/verified with `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (`src/lib/tokens.ts`). Payload: `{ sub, role, academy_id? }`.
- **Refresh token**: opaque random 32-byte value (`crypto.randomBytes`), **not** a JWT. Only its SHA-256 hash is stored in the DB (`RefreshToken` table); 30-day expiry. `POST /auth/refresh` rotates it (old hash revoked, new one issued) and includes **replay detection**: presenting an already-revoked refresh token revokes *all* refresh tokens for that subject (`src/modules/auth/service.ts:378-411`). This is a good, deliberate design.
- **Check-in token**: a separate short-lived (4h) `ES256` JWT scoped to `{batch_id, session_date}`, used to encode the academy's attendance QR code (`signCheckinToken`/`verifyCheckinToken`). It only proves "this is today's session" — actual identity still comes from the scanning student's own bearer token.
- Route protection: `app.requireAuth(role?)` (`src/plugins/auth.ts`) verifies the bearer JWT and optionally enforces `role === 'student' | 'academy'`. Nearly every route in every module is wrapped in this — confirmed by grepping all `routes.ts` files (see §4 for the handful of intentionally-public exceptions).

### 1.4 Student vs. Admin (academy) separation
There's no separate "admin API" — the same server handles both apps, distinguished entirely by the `role` claim in the JWT (`student` vs `academy`) and by separate OAuth client IDs/bundle IDs per app. `req.user.academy_id` is attached for academy-role tokens and every `studio/*` (admin) service function is passed `academy_id` explicitly and scopes its Prisma queries by it — this was spot-checked across `studio/routes.ts` and confirmed consistent (batches, programs, students, reviews, earnings, etc. all filter by the caller's own `academy_id`).

---

## 2. Required environment variables

Source of truth: `backend/api/.env.example` and `src/lib/env.ts` (Zod schema — this is what actually gets validated at boot; anything not in that schema is silently ignored by `env`, even if present in `.env`).

| Variable | Enforced by Zod schema | Used for |
|---|---|---|
| `NODE_ENV` | required (default `development`) | runtime mode |
| `PORT` | required (default `8080`) | HTTP port |
| `MOCK` | required (default `0`) | enables mock route responses — **must be `0`/unset in production** |
| `DATABASE_URL` | required | Postgres connection (Prisma) |
| `REDIS_URL` | required | BullMQ job queues / caching |
| `JWT_PRIVATE_KEY` | required | signs access + check-in tokens (ES256) |
| `JWT_PUBLIC_KEY` | required | verifies access + check-in tokens |
| `MSG91_AUTH_KEY` | optional | SMS OTP delivery — **without it, OTP only prints to server logs** |
| `MSG91_TEMPLATE_ID` | optional | MSG91 DLT-registered template |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | optional | payment order creation |
| `RAZORPAY_WEBHOOK_SECRET` | optional | verifies `/payments/webhook` signatures — **see Finding B, this being optional is a live bypass** |
| `HMS_ACCESS_KEY` / `HMS_SECRET` / `HMS_MANAGEMENT_TOKEN` / `HMS_TEMPLATE_ID` | optional | 100ms live-class rooms/tokens |
| `HMS_WEBHOOK_SECRET` | optional | verifies `/rooms/100ms/webhook` — **see Finding C, same pattern** |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | optional | Cloudflare R2 media storage (falls back to local disk if absent) |
| `GOOGLE_GEOCODING_KEY` | optional | address → lat/lng |
| `EXPO_ACCESS_TOKEN` | optional | push notification delivery via Expo |
| `SENTRY_DSN` | optional | error tracking |
| `APPLE_STUDENT_BUNDLE_ID` / `APPLE_ADMIN_BUNDLE_ID` | optional | Apple Sign-In audience per app |
| `GOOGLE_STUDENT_IOS_CLIENT_ID` / `GOOGLE_STUDENT_ANDROID_CLIENT_ID` | optional | Google Sign-In audience, student app |
| `GOOGLE_ADMIN_IOS_CLIENT_ID` / `GOOGLE_ADMIN_ANDROID_CLIENT_ID` | optional | Google Sign-In audience, admin app |

"Optional" here means the Zod schema won't fail boot without it — it does **not** mean safe to omit in production. `env.ts` treats `RAZORPAY_WEBHOOK_SECRET` and `HMS_WEBHOOK_SECRET` as optional, and the service code (§4) treats "unset" as "skip verification," which is the core problem in Findings B and C. A companion deployment doc already exists at `backend/api/setuprequired/GCP_DEPLOYMENT.md` with per-provider sign-up steps (MSG91, Razorpay, 100ms, R2, Google, Apple, Expo, Sentry) and marks all of the above as effectively required for a real production launch — that guidance is correct; the gap is that the *code* doesn't enforce it.

---

## 3. Secure generation & storage of these keys

**General rule for all of them:** never commit real values (`.env` is correctly gitignored and confirmed untracked in this repo's git history — good), inject secrets at deploy time from a secret manager, and use different values per environment (dev/staging/prod).

- **`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`** — generate your own EC P-256 keypair, don't reuse the placeholder in `.env.example`:
  ```
  openssl ecparam -name prime256v1 -genkey -noout -out private.pem
  openssl ec -in private.pem -pubout -out public.pem
  ```
  Store the PEM contents (including newlines) as secrets, e.g. `gcloud secrets create ... --data-file=private.pem`, then delete the local files. Rotating this key invalidates every outstanding access/refresh session simultaneously, so rotate deliberately (e.g. force re-login) rather than routinely.
- **`MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID`** — from the MSG91 dashboard (API section / SMS → Templates); requires DLT registration for India SMS. Treat the auth key as a bearer credential — restrict it to the SMS/OTP scope MSG91 offers, if their dashboard supports scoped keys.
- **`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`** — Settings → API Keys in the Razorpay dashboard. Use test-mode (`rzp_test_...`) keys in non-prod. The secret is shown once — store it immediately in your secret manager.
- **`RAZORPAY_WEBHOOK_SECRET`** — set when you configure the webhook endpoint (Settings → Webhooks); this is a value *you* choose, not one Razorpay generates — make it a long random string (e.g. `openssl rand -hex 32`), not something guessable, and set it in every environment that exposes `/payments/webhook`.
- **`HMS_ACCESS_KEY` / `HMS_SECRET` / `HMS_MANAGEMENT_TOKEN` / `HMS_TEMPLATE_ID` / `HMS_WEBHOOK_SECRET`** — 100ms dashboard → Developer → API Keys / Webhooks. Same rule for `HMS_WEBHOOK_SECRET` as above: pick a strong random value.
- **`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`** — Cloudflare dashboard → R2 → Manage API Tokens. Scope the token to **Object Read & Write on the specific bucket only**, not account-wide.
- **`GOOGLE_GEOCODING_KEY`** — GCP Console → Credentials → API Key. Restrict it to the Geocoding API and, if possible, to your server's egress IP — an unrestricted Maps key is a common source of billing abuse if leaked.
- **`EXPO_ACCESS_TOKEN`** — expo.dev account settings → Access Tokens. Scope one token per environment so you can revoke prod independently of staging.
- **`APPLE_*_BUNDLE_ID` / `GOOGLE_*_CLIENT_ID`** — these are identifiers, not shared secrets (they appear in client apps too), but they still gate which audiences your server accepts — keep student and admin values distinct as they are now, since mixing them would let an admin-app token pass as a student-app token or vice versa.
- **`DATABASE_URL` / `REDIS_URL`** — use a strong, generated password (not `findemy123` from `docker-compose.yml`, which is fine for local dev only — confirm it never reaches a shared/staging network) and prefer private networking (VPC/Cloud SQL proxy) over exposing the database publicly.
- **Storage mechanism, regardless of provider**: a secret manager (GCP Secret Manager, AWS Secrets Manager, Vault, etc.) injected as env vars at container start — never baked into the Docker image, never passed as plain `--set-env-vars` in CI logs. `GCP_DEPLOYMENT.md` §10 already documents this correctly for GCP.

---

## 4. Bypasses / weaknesses found in the current code

These are concrete, verified-by-reading-the-code issues, ranked by severity. I have **not** modified any of these files — fixes are described so your team can apply and review them.

### Finding A — IDOR: any authenticated student can read any other user's payment record
- **File:** `backend/api/src/modules/payments/routes.ts:25-28`, `backend/api/src/modules/payments/service.ts:299-314`, `backend/api/src/modules/payments/repo.ts:22-27`
- **What's wrong:** `GET /payments/:id` is behind `requireAuth('student')`, but the handler calls `service.getPayment(id)` — it never passes `req.user.id`, and `getPayment`/`findPaymentById` never filter by the caller. Any logged-in student can fetch any payment by ID (sequential/enumerable or leaked via other responses), exposing `razorpay_order_id`, `razorpay_payment_id`, amount, and status for a payment that isn't theirs.
- **Why this stands out as a bypass:** every comparable endpoint in the codebase (`bookings/:id`, `enrollments/:id`) *does* pass `req.user.id` through to the repo layer and scopes the query (`findBookingByIdAndUser`, `findEnrollmentByIdAndUser`). Payments is the one module where that scoping was dropped.
- **How to resolve (for your team to apply):** change the route to call `service.getPayment(id, req.user.id)`, and have `getPayment`/`findPaymentById` join through to the booking/enrollment and verify `booking.userId === userId` (or add a dedicated `findPaymentByIdAndUser` repo function mirroring the bookings pattern), throwing `NOT_FOUND` on mismatch (don't leak existence via a 403).

### Finding B — Razorpay webhook signature check silently skipped when the secret isn't configured
- **File:** `backend/api/src/modules/payments/service.ts:101-112`
- **What's wrong:** `const secret = env.RAZORPAY_WEBHOOK_SECRET || ''; if (secret) { ...verify... }`. If `RAZORPAY_WEBHOOK_SECRET` is unset or empty (which is literally the default in `.env.example`, and the schema marks it optional), the entire signature check is skipped and `handleWebhook` processes the payload as trusted — meaning anyone who can reach the endpoint can POST a fabricated `payment.captured` event and get a booking/enrollment marked paid for free. Separately, when the secret *is* set, `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))` will **throw** (not return false) if the attacker-supplied signature header has a different byte length than the computed HMAC — there's no length check before the call (contrast with the HMS webhook below, which does check length first).
- **How to resolve:** fail closed — reject the webhook (401) whenever `RAZORPAY_WEBHOOK_SECRET` isn't configured and the app isn't explicitly in mock/dev mode, rather than treating "no secret" as "skip check." Also add a `signature.length === expected.length` guard (or wrap the comparison in try/catch) before calling `timingSafeEqual`, matching the pattern already used correctly in the HMS webhook handler.

### Finding C — 100ms webhook signature check has the identical "fail open" bug
- **File:** `backend/api/src/modules/rooms/service.ts:96-108`
- **What's wrong:** Same shape as Finding B: `const secret = env.HMS_WEBHOOK_SECRET || ''; if (secret) { ...verify... }`. With `HMS_WEBHOOK_SECRET` unset, `POST /rooms/100ms/webhook` accepts any payload unverified. Since the handler resolves `(room_id, user_id)` from the body and calls `attendanceRepo.recordPresent(userId, batch.id, ...)`, an attacker who knows or guesses a `room_id` (batch IDs are also used as mock room IDs per `ensureLiveRoom`, so this may not even require guessing) and any `user_id` can mark arbitrary students "present" for a live session without ever joining, or spam the endpoint to manipulate attendance-based features (attendance tiers, refund eligibility, etc.).
- **How to resolve:** same as Finding B — require `HMS_WEBHOOK_SECRET` to be present and reject (401) if it's missing outside mock mode, instead of silently trusting the payload.

### Finding D — CORS reflects any origin while allowing credentials
- **File:** `backend/api/src/plugins/cors.ts:5-9`
- **What's wrong:** `cors` is registered with `{ origin: true, credentials: true }`. `origin: true` makes `@fastify/cors` reflect whatever `Origin` header the caller sends (i.e., every origin is allowed), and `credentials: true` tells browsers it's fine to include credentials on cross-origin requests. Because this API authenticates via `Authorization: Bearer` headers rather than cookies, the practical exploitability is lower than a cookie-based session would have — but a script on any third-party site can still make authenticated cross-origin requests using a token it obtained some other way (e.g. via XSS elsewhere, a malicious SDK, or a leaked token), and this configuration is what most security scanners will flag first.
- **How to resolve:** replace `origin: true` with an explicit allow-list (the student app's web origin, the admin app's web origin, and known local-dev origins), or drop `credentials: true` entirely if no cookie-based flow actually needs it (grep confirms auth here is Bearer-token only, not cookies).

### Finding E — No rate limiting on OTP request
- **File:** `backend/api/src/modules/auth/routes.ts:54-57` → `backend/api/src/modules/auth/service.ts` (`requestOtp`)
- **What's wrong:** `POST /auth/otp/request` has no per-phone or per-IP throttle anywhere in the request path (confirmed: `@fastify/rate-limit` isn't installed and no custom limiter is wired into `app.ts` or this route). Only `verify` caps wrong-code attempts at 5; `request` itself can be called unlimited times for the same phone number. This allows SMS-bombing a phone number (cost abuse against your MSG91 balance and a harassment vector) and, at volume, is unnecessary spend/abuse surface.
- **How to resolve:** add a rate limiter in front of `/auth/otp/request` — either `@fastify/rate-limit` scoped to that route, or a Redis-backed counter keyed on `phone` (and/or IP) with a short window (e.g. 3 requests / 10 minutes), since Redis is already a dependency here.

### Finding F — No global security headers or app-level rate limiting
- **File:** `backend/api/src/app.ts`
- **What's wrong:** The only plugins registered are error-handling, CORS, auth, mock, and multipart — there's no `@fastify/helmet` (standard headers like `X-Content-Type-Options`, `Strict-Transport-Security`, etc.) and no app-wide rate limiter as defense-in-depth beyond Finding E's specific gap.
- **How to resolve:** register `@fastify/helmet` and a conservative global `@fastify/rate-limit` in `buildApp()`, tuned so it doesn't interfere with legitimate polling/webhook traffic.

---

## 5. What's already solid (so it isn't re-litigated later)

- OTP codes and refresh tokens are stored hashed, never in plaintext; OTP comparison uses `timingSafeEqual`.
- Refresh-token rotation has real replay detection (reuse of a revoked token nukes all sessions for that subject).
- OAuth verification correctly pins issuer + audience per provider and per app (student vs admin), with distinct, accurately-mapped error codes for expired/audience-mismatch/issuer-mismatch/unreachable-JWKS.
- Every `studio/*` (admin) route consistently scopes queries by the caller's own `academy_id` — no cross-academy IDOR found there.
- Local media path traversal (`readLocalMedia` in `src/lib/media-storage.ts`) is guarded reasonably (normalize + strip leading `..` + `startsWith` check on the resolved path).
- `.env` is correctly gitignored and confirmed absent from git history in this repo.
