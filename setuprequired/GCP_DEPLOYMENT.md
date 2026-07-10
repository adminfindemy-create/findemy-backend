# Findemy API — GCP Deployment Guide

This guide covers everything required to deploy the Findemy backend API (`@findemy/api`) on Google Cloud Platform, including infrastructure setup, environment variable plumbing, push notification configuration, and production hardening.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [GCP Account & Project Setup](#2-gcp-account--project-setup)
3. [Required GCP Services](#3-required-gcp-services)
4. [Cloud SQL (PostgreSQL)](#4-cloud-sql-postgresql)
5. [Memorystore (Redis)](#5-memorystore-redis)
6. [Cloud Run Setup](#6-cloud-run-setup)
7. [Artifact Registry (Docker)](#7-artifact-registry-docker)
8. [Dockerfile](#8-dockerfile)
9. [Environment Variables — Full Reference](#9-environment-variables--full-reference)
10. [Secret Manager — .env Plumbing](#10-secret-manager--env-plumbing)
11. [Expo Push Notifications Setup](#11-expo-push-notifications-setup)
12. [Third-Party Account Setup](#12-third-party-account-setup)
13. [JWT Key Generation](#13-jwt-key-generation)
14. [Database Migration & Seed](#14-database-migration--seed)
15. [Background Worker Deployment](#15-background-worker-deployment)
16. [CI/CD with Cloud Build](#16-cicd-with-cloud-build)
17. [VPC & Networking](#17-vpc--networking)
18. [IAM Roles Summary](#18-iam-roles-summary)
19. [Health Check & Monitoring](#19-health-check--monitoring)
20. [Cost Estimate](#20-cost-estimate)
21. [Quick-Start Checklist](#21-quick-start-checklist)

---

## 1. Architecture Overview

```
Internet
    │
    ▼
Cloud Run (API)  ──────────────────────────────────────────────────┐
    │                                                               │
    ├── Cloud SQL (PostgreSQL 16)  via Cloud SQL Auth Proxy        │
    ├── Memorystore (Redis 7)      via VPC Serverless Connector    │
    ├── Cloudflare R2              via HTTPS (media storage)       │
    ├── Expo Push Servers          via HTTPS                       │
    ├── Razorpay                   via HTTPS (payments)            │
    ├── MSG91                      via HTTPS (SMS OTP)             │
    └── 100ms                      via HTTPS (live classes)        │
                                                                    │
Cloud Run (Worker)  ────────────────────────────────────────────────┘
    │   (separate service, same env vars, runs BullMQ workers)
    ▼
Memorystore (Redis) — shared job queue
```

**Two Cloud Run services are required:**
- `findemy-api` — HTTP server (`node dist/server.js`)
- `findemy-worker` — Background jobs (`node dist/workers/index.js`)  
  *(No HTTP port needed; set `--no-traffic` and `--min-instances=1`)*

---

## 2. GCP Account & Project Setup

### 2.1 Install & Authenticate gcloud CLI

```bash
# Install: https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud auth application-default login
```

### 2.2 Create or Select a Project

```bash
# Create new project
gcloud projects create findemy-prod --name="Findemy Production"

# Or use existing
gcloud config set project findemy-prod
```

### 2.3 Link Billing

Go to **GCP Console → Billing** and link a billing account to `findemy-prod`. Cloud SQL and Memorystore require billing to be enabled.

### 2.4 Enable Required APIs

Run this once — enables all services used by this guide:

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  redis.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com \
  compute.googleapis.com \
  cloudresourcemanager.googleapis.com
```

---

## 3. Required GCP Services

| Service | Purpose | Tier Recommendation |
|---|---|---|
| Cloud Run | API + Worker containers | Gen 2, 1 vCPU / 512 MB min |
| Cloud SQL (PostgreSQL 16) | Primary database | `db-g1-small` for staging, `db-custom-2-4096` for prod |
| Memorystore (Redis 7) | BullMQ queues + caching | `BASIC` 1 GB for staging, `STANDARD_HA` for prod |
| Artifact Registry | Docker image storage | Standard |
| Secret Manager | .env secret storage | Pay-per-access |
| Cloud Build | CI/CD | Default pool |
| VPC + Serverless VPC Connector | Private networking for Redis | Required |

---

## 4. Cloud SQL (PostgreSQL)

### 4.1 Create Instance

```bash
gcloud sql instances create findemy-pg \
  --database-version=POSTGRES_16 \
  --tier=db-g1-small \
  --region=asia-south1 \
  --storage-auto-increase \
  --storage-size=20GB \
  --backup-start-time=02:00 \
  --enable-bin-log \
  --deletion-protection
```

> **Region:** `asia-south1` (Mumbai) is closest for India-based deployments.

### 4.2 Create Database and User

```bash
gcloud sql databases create findemy --instance=findemy-pg

gcloud sql users create findemy \
  --instance=findemy-pg \
  --password=STRONG_PASSWORD_HERE
```

### 4.3 Get Connection Name

```bash
gcloud sql instances describe findemy-pg --format="value(connectionName)"
# Output: findemy-prod:asia-south1:findemy-pg
```

Save this — you need it for Cloud Run.

### 4.4 DATABASE_URL Format for Cloud Run

Cloud Run connects via the Cloud SQL Auth Proxy socket automatically when you pass `--add-cloudsql-instances`. The DATABASE_URL uses a Unix socket:

```
DATABASE_URL=postgresql://findemy:STRONG_PASSWORD_HERE@localhost/findemy?host=/cloudsql/findemy-prod:asia-south1:findemy-pg
```

> **Note:** For local development use TCP (`postgres://findemy:password@127.0.0.1:5433/findemy`). For Cloud Run use the socket path above.

---

## 5. Memorystore (Redis)

### 5.1 Create VPC (if you don't have one)

```bash
gcloud compute networks create findemy-vpc --subnet-mode=auto
```

### 5.2 Create Serverless VPC Connector

Cloud Run needs this to reach Memorystore (which is on a private IP):

```bash
gcloud compute networks vpc-access connectors create findemy-connector \
  --region=asia-south1 \
  --network=findemy-vpc \
  --range=10.8.0.0/28 \
  --min-instances=2 \
  --max-instances=10
```

### 5.3 Create Redis Instance

```bash
gcloud redis instances create findemy-redis \
  --size=1 \
  --region=asia-south1 \
  --network=findemy-vpc \
  --redis-version=redis_7_0 \
  --tier=BASIC
```

### 5.4 Get Redis IP

```bash
gcloud redis instances describe findemy-redis \
  --region=asia-south1 \
  --format="value(host)"
# Output: 10.x.x.x
```

Your `REDIS_URL` will be:

```
REDIS_URL=redis://10.x.x.x:6379
```

---

## 6. Cloud Run Setup

### 6.1 Create Service Account for Cloud Run

```bash
gcloud iam service-accounts create findemy-api-sa \
  --display-name="Findemy API Service Account"

SA_EMAIL="findemy-api-sa@findemy-prod.iam.gserviceaccount.com"
```

### 6.2 Grant Required Roles

```bash
# Cloud SQL client
gcloud projects add-iam-policy-binding findemy-prod \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudsql.client"

# Secret Manager accessor
gcloud projects add-iam-policy-binding findemy-prod \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

### 6.3 Deploy API Service

```bash
gcloud run deploy findemy-api \
  --image=asia-south1-docker.pkg.dev/findemy-prod/findemy/api:latest \
  --region=asia-south1 \
  --platform=managed \
  --service-account=$SA_EMAIL \
  --add-cloudsql-instances=findemy-prod:asia-south1:findemy-pg \
  --vpc-connector=findemy-connector \
  --vpc-egress=private-ranges-only \
  --port=8080 \
  --min-instances=1 \
  --max-instances=10 \
  --memory=512Mi \
  --cpu=1 \
  --concurrency=80 \
  --timeout=60 \
  --set-secrets="DATABASE_URL=findemy-database-url:latest,REDIS_URL=findemy-redis-url:latest,JWT_PRIVATE_KEY=findemy-jwt-private-key:latest,JWT_PUBLIC_KEY=findemy-jwt-public-key:latest,MSG91_AUTH_KEY=findemy-msg91-auth-key:latest,MSG91_TEMPLATE_ID=findemy-msg91-template-id:latest,RAZORPAY_KEY_ID=findemy-razorpay-key-id:latest,RAZORPAY_KEY_SECRET=findemy-razorpay-key-secret:latest,RAZORPAY_WEBHOOK_SECRET=findemy-razorpay-webhook-secret:latest,HMS_ACCESS_KEY=findemy-hms-access-key:latest,HMS_SECRET=findemy-hms-secret:latest,HMS_MANAGEMENT_TOKEN=findemy-hms-management-token:latest,HMS_TEMPLATE_ID=findemy-hms-template-id:latest,HMS_WEBHOOK_SECRET=findemy-hms-webhook-secret:latest,R2_ACCOUNT_ID=findemy-r2-account-id:latest,R2_ACCESS_KEY_ID=findemy-r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=findemy-r2-secret-access-key:latest,R2_BUCKET=findemy-r2-bucket:latest,GOOGLE_GEOCODING_KEY=findemy-google-geocoding-key:latest,EXPO_ACCESS_TOKEN=findemy-expo-access-token:latest,SENTRY_DSN=findemy-sentry-dsn:latest,APPLE_STUDENT_BUNDLE_ID=findemy-apple-student-bundle-id:latest,APPLE_ADMIN_BUNDLE_ID=findemy-apple-admin-bundle-id:latest,GOOGLE_STUDENT_IOS_CLIENT_ID=findemy-google-student-ios-client-id:latest,GOOGLE_STUDENT_ANDROID_CLIENT_ID=findemy-google-student-android-client-id:latest,GOOGLE_ADMIN_IOS_CLIENT_ID=findemy-google-admin-ios-client-id:latest,GOOGLE_ADMIN_ANDROID_CLIENT_ID=findemy-google-admin-android-client-id:latest" \
  --set-env-vars="NODE_ENV=production,PORT=8080" \
  --allow-unauthenticated
```

### 6.4 Deploy Worker Service

```bash
gcloud run deploy findemy-worker \
  --image=asia-south1-docker.pkg.dev/findemy-prod/findemy/api:latest \
  --region=asia-south1 \
  --platform=managed \
  --service-account=$SA_EMAIL \
  --add-cloudsql-instances=findemy-prod:asia-south1:findemy-pg \
  --vpc-connector=findemy-connector \
  --vpc-egress=all-traffic \
  --no-traffic \
  --min-instances=1 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=3600 \
  --command="node" \
  --args="dist/workers/index.js" \
  --set-secrets="DATABASE_URL=findemy-database-url:latest,REDIS_URL=findemy-redis-url:latest,JWT_PRIVATE_KEY=findemy-jwt-private-key:latest,JWT_PUBLIC_KEY=findemy-jwt-public-key:latest,EXPO_ACCESS_TOKEN=findemy-expo-access-token:latest,RAZORPAY_KEY_ID=findemy-razorpay-key-id:latest,RAZORPAY_KEY_SECRET=findemy-razorpay-key-secret:latest,SENTRY_DSN=findemy-sentry-dsn:latest" \
  --set-env-vars="NODE_ENV=production"
```

> The worker has no HTTP port — Cloud Run will keep it alive via `--min-instances=1`.

---

## 7. Artifact Registry (Docker)

### 7.1 Create Repository

```bash
gcloud artifacts repositories create findemy \
  --repository-format=docker \
  --location=asia-south1 \
  --description="Findemy Docker images"
```

### 7.2 Configure Docker Auth

```bash
gcloud auth configure-docker asia-south1-docker.pkg.dev
```

---

## 8. Dockerfile

No Dockerfile exists in the repo. Create it at `backend/api/Dockerfile`:

```dockerfile
# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npx prisma generate
RUN npm run build

# ---- Production Stage ----
FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodeuser

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

USER nodeuser

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
```

### Build & Push

```bash
cd backend/api

IMAGE=asia-south1-docker.pkg.dev/findemy-prod/findemy/api

docker build -t $IMAGE:latest .
docker push $IMAGE:latest
```

---

## 9. Environment Variables — Full Reference

All variables from `.env.example` with descriptions and whether they are required for production:

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `PORT` | Yes | HTTP port — set to `8080` for Cloud Run |
| `DATABASE_URL` | Yes | PostgreSQL connection string (see §4.4) |
| `REDIS_URL` | Yes | Redis connection string (see §5.4) |
| `JWT_PRIVATE_KEY` | Yes | EC private key PEM for signing JWTs (see §13) |
| `JWT_PUBLIC_KEY` | Yes | EC public key PEM for verifying JWTs (see §13) |
| `MSG91_AUTH_KEY` | Yes | MSG91 API key for SMS OTP delivery |
| `MSG91_TEMPLATE_ID` | Yes | MSG91 template ID for OTP messages |
| `RAZORPAY_KEY_ID` | Yes | Razorpay public key ID |
| `RAZORPAY_KEY_SECRET` | Yes | Razorpay secret key |
| `RAZORPAY_WEBHOOK_SECRET` | Yes | Secret for verifying Razorpay webhook signatures |
| `HMS_ACCESS_KEY` | If live classes used | 100ms access key |
| `HMS_SECRET` | If live classes used | 100ms secret |
| `HMS_MANAGEMENT_TOKEN` | If live classes used | 100ms management token |
| `HMS_TEMPLATE_ID` | If live classes used | 100ms room template ID |
| `HMS_WEBHOOK_SECRET` | If live classes used | 100ms webhook secret |
| `R2_ACCOUNT_ID` | Yes (media uploads) | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Yes (media uploads) | Cloudflare R2 access key |
| `R2_SECRET_ACCESS_KEY` | Yes (media uploads) | Cloudflare R2 secret |
| `R2_BUCKET` | Yes (media uploads) | R2 bucket name |
| `GOOGLE_GEOCODING_KEY` | Yes (location search) | Google Maps Geocoding API key |
| `EXPO_ACCESS_TOKEN` | Yes (push notifications) | Expo project access token |
| `SENTRY_DSN` | Recommended | Sentry DSN for error tracking |
| `APPLE_STUDENT_BUNDLE_ID` | Yes (Apple login) | iOS bundle ID for student app |
| `APPLE_ADMIN_BUNDLE_ID` | Yes (Apple login) | iOS bundle ID for admin app |
| `GOOGLE_STUDENT_IOS_CLIENT_ID` | Yes (Google login) | Google OAuth iOS client ID for student app |
| `GOOGLE_STUDENT_ANDROID_CLIENT_ID` | Yes (Google login) | Google OAuth Android client ID for student app |
| `GOOGLE_ADMIN_IOS_CLIENT_ID` | Yes (Google login) | Google OAuth iOS client ID for admin app |
| `GOOGLE_ADMIN_ANDROID_CLIENT_ID` | Yes (Google login) | Google OAuth Android client ID for admin app |

---

## 10. Secret Manager — .env Plumbing

Never put secrets directly in Cloud Run environment variable flags in CI (they appear in logs). Store every secret in Secret Manager and mount them via `--set-secrets`.

### 10.1 Create All Secrets

Run this script once, substituting your actual values:

```bash
#!/bin/bash
PROJECT=findemy-prod

create_secret() {
  local name=$1
  local value=$2
  echo -n "$value" | gcloud secrets create "$name" \
    --data-file=- \
    --project=$PROJECT \
    --replication-policy=automatic
}

# Core
create_secret findemy-database-url "postgresql://findemy:STRONG_PASSWORD@localhost/findemy?host=/cloudsql/findemy-prod:asia-south1:findemy-pg"
create_secret findemy-redis-url "redis://10.x.x.x:6379"

# JWT Keys — paste PEM content (see §13)
create_secret findemy-jwt-private-key "$(cat private.pem)"
create_secret findemy-jwt-public-key "$(cat public.pem)"

# SMS
create_secret findemy-msg91-auth-key "YOUR_MSG91_AUTH_KEY"
create_secret findemy-msg91-template-id "YOUR_MSG91_TEMPLATE_ID"

# Payments
create_secret findemy-razorpay-key-id "rzp_live_XXXXXXXXXX"
create_secret findemy-razorpay-key-secret "YOUR_RAZORPAY_SECRET"
create_secret findemy-razorpay-webhook-secret "YOUR_WEBHOOK_SECRET"

# 100ms Live Classes
create_secret findemy-hms-access-key "YOUR_HMS_ACCESS_KEY"
create_secret findemy-hms-secret "YOUR_HMS_SECRET"
create_secret findemy-hms-management-token "YOUR_HMS_MGMT_TOKEN"
create_secret findemy-hms-template-id "YOUR_HMS_TEMPLATE_ID"
create_secret findemy-hms-webhook-secret "YOUR_HMS_WEBHOOK_SECRET"

# Cloudflare R2
create_secret findemy-r2-account-id "YOUR_CF_ACCOUNT_ID"
create_secret findemy-r2-access-key-id "YOUR_R2_ACCESS_KEY"
create_secret findemy-r2-secret-access-key "YOUR_R2_SECRET"
create_secret findemy-r2-bucket "findemy-media"

# Google
create_secret findemy-google-geocoding-key "YOUR_GEOCODING_API_KEY"
create_secret findemy-google-student-ios-client-id "YOUR_ID.apps.googleusercontent.com"
create_secret findemy-google-student-android-client-id "YOUR_ID.apps.googleusercontent.com"
create_secret findemy-google-admin-ios-client-id "YOUR_ID.apps.googleusercontent.com"
create_secret findemy-google-admin-android-client-id "YOUR_ID.apps.googleusercontent.com"

# Apple
create_secret findemy-apple-student-bundle-id "com.findemy.student"
create_secret findemy-apple-admin-bundle-id "com.findemy.admin"

# Expo Push
create_secret findemy-expo-access-token "YOUR_EXPO_ACCESS_TOKEN"

# Sentry
create_secret findemy-sentry-dsn "https://xxx@xxx.ingest.sentry.io/xxx"
```

### 10.2 Update an Existing Secret

```bash
echo -n "NEW_VALUE" | gcloud secrets versions add findemy-razorpay-key-secret --data-file=-
```

### 10.3 Verify Secrets Are Accessible

```bash
gcloud secrets versions access latest --secret=findemy-database-url
```

---

## 11. Expo Push Notifications Setup

The app uses **Expo Server SDK** (not Firebase FCM directly). Expo acts as the push delivery layer for both iOS (APNs) and Android (FCM), so you register once with Expo instead of separately with Apple and Google.

### 11.1 Create an Expo Account

1. Go to [expo.dev](https://expo.dev) and create an account.
2. Create a new project (e.g., `findemy`).

### 11.2 Configure Push Credentials in Expo

Expo EAS (Expo Application Services) manages your APNs and FCM credentials:

```bash
# Install EAS CLI globally
npm install -g eas-cli

# Login
eas login

# Navigate to your mobile app directory
cd path/to/your/mobile-app

# Set up push credentials (run for both student and admin apps)
eas credentials
# Select: iOS → Push Notifications → Add new credentials (Apple will generate a key)
# Select: Android → Push Notifications → Add FCM key
```

**What this does:**
- For **iOS**: Uploads an APNs Auth Key to Expo's servers (requires Apple Developer account).
- For **Android**: Links your FCM server key to Expo (requires a Firebase project).

### 11.3 Generate an Expo Access Token

This token is what the backend uses to authenticate push sends via `EXPO_ACCESS_TOKEN`:

1. Log in to [expo.dev/accounts/YOUR_USERNAME/settings/access-tokens](https://expo.dev/accounts/YOUR_USERNAME/settings/access-tokens)
2. Click **Create token**
3. Name it `findemy-backend-prod`
4. Copy the token — this is your `EXPO_ACCESS_TOKEN`

Store it in Secret Manager:

```bash
echo -n "expo_YOUR_TOKEN_HERE" | gcloud secrets versions add findemy-expo-access-token --data-file=-
```

### 11.4 iOS Prerequisites (Apple Developer Account)

Required for iOS push notifications to work end-to-end:

1. Go to [developer.apple.com](https://developer.apple.com) → **Certificates, IDs & Profiles**
2. Create an **App ID** for each bundle ID:
   - `com.findemy.student` (or your actual bundle ID in `APPLE_STUDENT_BUNDLE_ID`)
   - `com.findemy.admin` (or your actual bundle ID in `APPLE_ADMIN_BUNDLE_ID`)
3. Enable **Push Notifications** capability for each App ID
4. Create an **APNs Auth Key** (`.p8` file) under **Keys → + → Apple Push Notifications service (APNs)**
5. Upload this `.p8` key to Expo via `eas credentials` (see §11.2)

### 11.5 Android Prerequisites (Firebase Project)

Required for Android push notifications:

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a project (or use existing)
3. Add Android apps:
   - Student app (package name matching your Android app)
   - Admin app (package name matching your Android app)
4. Go to **Project Settings → Cloud Messaging**
5. Copy the **Server Key**
6. Provide this to Expo via `eas credentials` or directly to Expo dashboard

> **Note:** You do NOT set FCM or APNs keys in this backend's `.env`. Expo handles the APNs/FCM relay. The backend only needs `EXPO_ACCESS_TOKEN` to send to Expo's servers, and Expo forwards to APNs/FCM.

### 11.6 How Push Notifications Flow in This App

```
Backend (BullMQ worker)
    │
    │  POST https://exp.host/--/api/v2/push/send
    │  Authorization: Bearer $EXPO_ACCESS_TOKEN
    ▼
Expo Push Service
    ├── iOS  → APNs → Device
    └── Android → FCM → Device
```

Workers that send push notifications:
- `renewal-reminder` — daily at 03:30 IST
- `class-reminder` — every 15 minutes

---

## 12. Third-Party Account Setup

### 12.1 MSG91 (SMS OTP)

1. Sign up at [msg91.com](https://msg91.com)
2. Go to **API** → copy your **Auth Key** → `MSG91_AUTH_KEY`
3. Go to **SMS** → **Templates** → Create a new template for OTP delivery
4. Copy the **Template ID** → `MSG91_TEMPLATE_ID`
5. Ensure DLT registration is complete (required in India for SMS delivery)

### 12.2 Razorpay (Payments)

1. Sign up at [razorpay.com](https://razorpay.com) and complete KYC
2. Go to **Settings → API Keys** → Generate a key pair
   - `RAZORPAY_KEY_ID` = `rzp_live_XXXXXXXXXX`
   - `RAZORPAY_KEY_SECRET` = the secret shown once
3. Go to **Settings → Webhooks** → Add a webhook:
   - URL: `https://YOUR_CLOUD_RUN_URL/payments/webhook`
   - Events: `payment.captured`, `payment.failed`, `refund.created`
   - Set a secret → `RAZORPAY_WEBHOOK_SECRET`

### 12.3 100ms (Live Video Classes)

1. Sign up at [100ms.live](https://dashboard.100ms.live)
2. Create a workspace
3. Go to **Developer** → **API Keys**:
   - `HMS_ACCESS_KEY`
   - `HMS_SECRET`
4. Go to **Templates** → Create a template for classrooms → `HMS_TEMPLATE_ID`
5. Go to **Developer** → **Webhooks** → Add endpoint:
   - URL: `https://YOUR_CLOUD_RUN_URL/rooms/webhook`
   - Copy the webhook secret → `HMS_WEBHOOK_SECRET`
6. Generate a management token (use 100ms SDK or their token generator):
   - `HMS_MANAGEMENT_TOKEN`

### 12.4 Cloudflare R2 (Media Storage)

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **R2** → **Create bucket** → name it (e.g., `findemy-media`) → `R2_BUCKET`
3. Copy your **Account ID** from the right sidebar → `R2_ACCOUNT_ID`
4. Go to **R2 → Manage R2 API Tokens** → **Create API Token**
   - Permission: **Object Read & Write**
   - Copy **Access Key ID** → `R2_ACCESS_KEY_ID`
   - Copy **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
5. Configure public access or signed URLs on the bucket as needed for media serving

### 12.5 Google Maps Geocoding API

1. Go to [console.cloud.google.com/apis/library/geocoding-backend.googleapis.com](https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com)
2. Enable the **Geocoding API**
3. Go to **Credentials** → **Create Credentials** → **API Key**
4. Restrict the key to **Geocoding API** only and to your Cloud Run service IPs (optional but recommended)
5. Copy → `GOOGLE_GEOCODING_KEY`

### 12.6 Google OAuth (Sign In with Google)

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 Client IDs for each platform:
   - **iOS (Student)** → type: iOS, bundle ID: `APPLE_STUDENT_BUNDLE_ID` → `GOOGLE_STUDENT_IOS_CLIENT_ID`
   - **Android (Student)** → type: Android, package name of student app → `GOOGLE_STUDENT_ANDROID_CLIENT_ID`
   - **iOS (Admin)** → type: iOS, bundle ID: `APPLE_ADMIN_BUNDLE_ID` → `GOOGLE_ADMIN_IOS_CLIENT_ID`
   - **Android (Admin)** → type: Android, package name of admin app → `GOOGLE_ADMIN_ANDROID_CLIENT_ID`

### 12.7 Apple Sign In

1. Go to [developer.apple.com](https://developer.apple.com) → **Certificates, Identifiers & Profiles**
2. Under **Identifiers**, enable **Sign In with Apple** for each App ID
3. Set `APPLE_STUDENT_BUNDLE_ID` and `APPLE_ADMIN_BUNDLE_ID` to their respective bundle identifiers (e.g., `com.findemy.student`)

### 12.8 Sentry (Error Tracking)

1. Sign up at [sentry.io](https://sentry.io)
2. Create a project → **Node.js**
3. Copy the **DSN** → `SENTRY_DSN`

---

## 13. JWT Key Generation

The app uses **ECDSA (ES256)** keys for JWT signing. Generate them once and store in Secret Manager.

```bash
# Generate EC private key (P-256 curve)
openssl ecparam -name prime256v1 -genkey -noout -out private.pem

# Extract public key
openssl ec -in private.pem -pubout -out public.pem

# Verify
cat private.pem   # Should start with: -----BEGIN EC PRIVATE KEY-----
cat public.pem    # Should start with: -----BEGIN PUBLIC KEY-----
```

Store in Secret Manager:

```bash
gcloud secrets create findemy-jwt-private-key --data-file=private.pem --replication-policy=automatic
gcloud secrets create findemy-jwt-public-key --data-file=public.pem --replication-policy=automatic

# Delete local files after storing
rm private.pem public.pem
```

> **Critical:** Never commit these files to git. The PEM content includes newlines — Secret Manager handles multi-line values correctly when stored via `--data-file`.

---

## 14. Database Migration & Seed

### 14.1 Run Migrations (Production)

After deploying Cloud Run (or during CI), run migrations against Cloud SQL:

**Option A — One-off Cloud Run Job (recommended for prod):**

```bash
gcloud run jobs create findemy-migrate \
  --image=asia-south1-docker.pkg.dev/findemy-prod/findemy/api:latest \
  --region=asia-south1 \
  --service-account=$SA_EMAIL \
  --add-cloudsql-instances=findemy-prod:asia-south1:findemy-pg \
  --vpc-connector=findemy-connector \
  --set-secrets="DATABASE_URL=findemy-database-url:latest" \
  --set-env-vars="NODE_ENV=production" \
  --command="npx" \
  --args="prisma,migrate,deploy"

# Execute
gcloud run jobs execute findemy-migrate --region=asia-south1 --wait
```

**Option B — Add to Dockerfile CMD as startup step:**

In your Dockerfile, change CMD to run migration then start:

```dockerfile
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

> Option A is safer — migrations are idempotent but should run before traffic hits the new binary.

### 14.2 Seed (Staging Only)

Only run seeding in staging/dev — never against production:

```bash
gcloud run jobs execute findemy-migrate \
  --region=asia-south1 \
  --wait \
  --override-args="npx,tsx,prisma/seed.ts"
```

---

## 15. Background Worker Deployment

The `findemy-worker` Cloud Run service runs BullMQ workers that process:

| Worker | Schedule | Purpose |
|---|---|---|
| `otp-sweeper` | Every 5 min | Purge expired OTPs |
| `slot-ttl` | Every 2 min | Release expired slot holds |
| `trial-reminder` | Every 5 min | Send trial reminder push notifications |
| `attendance-close` | Hourly | Auto-close attendance windows |
| `webhook-retry` | Every 10 min | Retry failed Razorpay webhooks |
| `enrollment-lifecycle` | Hourly | Process enrollment state transitions |
| `renewal-reminder` | 03:30 IST daily | Push notification for upcoming renewals |
| `refund-reconcile` | Every 30 min | Reconcile pending refund statuses |
| `class-reminder` | Every 15 min | Push notification before class starts |
| `reserve-release` | 04:00 IST daily | Release expired payment holds |

**The worker process must stay alive 24/7** — that's why `--min-instances=1` is set and `--no-traffic` prevents it from receiving HTTP requests.

If the worker crashes, Cloud Run will restart it automatically. Monitor via:

```bash
gcloud run services logs read findemy-worker --region=asia-south1 --limit=50
```

---

## 16. CI/CD with Cloud Build

Create `cloudbuild.yaml` at the repo root:

```yaml
steps:
  # Build Docker image
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - build
      - -t
      - asia-south1-docker.pkg.dev/$PROJECT_ID/findemy/api:$COMMIT_SHA
      - -t
      - asia-south1-docker.pkg.dev/$PROJECT_ID/findemy/api:latest
      - backend/api

  # Push image
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - push
      - --all-tags
      - asia-south1-docker.pkg.dev/$PROJECT_ID/findemy/api

  # Run database migrations
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - run
      - jobs
      - execute
      - findemy-migrate
      - --region=asia-south1
      - --wait

  # Deploy API
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - run
      - deploy
      - findemy-api
      - --image=asia-south1-docker.pkg.dev/$PROJECT_ID/findemy/api:$COMMIT_SHA
      - --region=asia-south1
      - --platform=managed

  # Deploy Worker
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - run
      - deploy
      - findemy-worker
      - --image=asia-south1-docker.pkg.dev/$PROJECT_ID/findemy/api:$COMMIT_SHA
      - --region=asia-south1
      - --platform=managed

images:
  - asia-south1-docker.pkg.dev/$PROJECT_ID/findemy/api:$COMMIT_SHA
  - asia-south1-docker.pkg.dev/$PROJECT_ID/findemy/api:latest

options:
  logging: CLOUD_LOGGING_ONLY
```

Grant Cloud Build the necessary permissions:

```bash
PROJECT_NUMBER=$(gcloud projects describe findemy-prod --format="value(projectNumber)")
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding findemy-prod \
  --member="serviceAccount:$CB_SA" --role="roles/run.admin"

gcloud projects add-iam-policy-binding findemy-prod \
  --member="serviceAccount:$CB_SA" --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding findemy-prod \
  --member="serviceAccount:$CB_SA" --role="roles/cloudsql.admin"
```

---

## 17. VPC & Networking

- Cloud SQL and Memorystore are on **private IPs** inside the VPC.
- Cloud Run accesses them via the **Serverless VPC Connector** (`findemy-connector`).
- The API Cloud Run service uses `--vpc-egress=private-ranges-only` (only private traffic goes through VPC; public internet calls like Razorpay, Expo, R2 go directly).
- The Worker uses `--vpc-egress=all-traffic` if any worker needs to reach internal services only.

**Firewall (auto-configured):** The VPC connector creates the necessary firewall rules automatically. No manual firewall configuration is needed.

---

## 18. IAM Roles Summary

| Principal | Role | Reason |
|---|---|---|
| `findemy-api-sa` | `roles/cloudsql.client` | Connect to Cloud SQL |
| `findemy-api-sa` | `roles/secretmanager.secretAccessor` | Read secrets at runtime |
| Cloud Build SA | `roles/run.admin` | Deploy Cloud Run services |
| Cloud Build SA | `roles/iam.serviceAccountUser` | Act as the Cloud Run service account |
| Cloud Build SA | `roles/cloudsql.admin` | Trigger migration jobs |

---

## 19. Health Check & Monitoring

### Health Endpoint

The API exposes `GET /health`:

```json
{ "ok": true, "version": "0.0.1", "uptime_s": 42 }
```

Cloud Run automatically uses this for startup and liveness checks. Configure it:

```bash
gcloud run services update findemy-api \
  --region=asia-south1 \
  --health-checks=liveness \
  --liveness-probe-path=/health
```

### Log Viewing

```bash
# API logs
gcloud run services logs read findemy-api --region=asia-south1

# Worker logs
gcloud run services logs read findemy-worker --region=asia-south1

# Tail live
gcloud beta run services logs tail findemy-api --region=asia-south1
```

### Alerts

Set up an uptime check in **Cloud Monitoring → Uptime Checks** pointing to your Cloud Run URL at `/health`. Create an alert policy to notify on failure.

---

## 20. Cost Estimate

Approximate monthly costs for low-to-medium traffic (India region):

| Service | Spec | Est. Cost/month |
|---|---|---|
| Cloud Run (API) | 1 vCPU, 512 MB, 1 min instance | ~$5–20 |
| Cloud Run (Worker) | 1 vCPU, 512 MB, always-on | ~$15 |
| Cloud SQL | `db-g1-small`, 20 GB | ~$10–25 |
| Memorystore Redis | 1 GB BASIC | ~$25 |
| Artifact Registry | < 1 GB images | ~$0.10 |
| Secret Manager | < 20 secrets | ~$0.30 |
| Cloud Build | < 120 min/day free tier | ~$0 |
| **Total** | | **~$55–85/month** |

---

## 21. Quick-Start Checklist

Use this as a deployment runbook:

### Accounts & Credentials
- [ ] GCP project created and billing linked
- [ ] All GCP APIs enabled (§2.4)
- [ ] Expo account created and push credentials configured (§11.1–11.5)
- [ ] Apple Developer account with App IDs and APNs key (§11.4)
- [ ] Firebase project with FCM configured (§11.5)
- [ ] MSG91 account with DLT-registered OTP template (§12.1)
- [ ] Razorpay live account with webhook configured (§12.2)
- [ ] 100ms workspace with template and webhook (§12.3)
- [ ] Cloudflare R2 bucket and API token (§12.4)
- [ ] Google Maps Geocoding API key (§12.5)
- [ ] Google OAuth client IDs for all 4 app combinations (§12.6)
- [ ] Sentry project and DSN (§12.8)

### GCP Infrastructure
- [ ] VPC network created (§5.1)
- [ ] Serverless VPC Connector created (§5.2)
- [ ] Cloud SQL instance created (§4.1)
- [ ] Cloud SQL database and user created (§4.2)
- [ ] Memorystore Redis instance created (§5.3)
- [ ] Artifact Registry repository created (§7.1)
- [ ] Service account created with correct IAM roles (§6.1–6.2)

### Secrets & Config
- [ ] JWT keys generated and stored in Secret Manager (§13)
- [ ] All secrets created in Secret Manager (§10.1)
- [ ] DATABASE_URL uses Cloud SQL socket path (§4.4)
- [ ] REDIS_URL uses Memorystore private IP (§5.4)

### Build & Deploy
- [ ] Dockerfile created at `backend/api/Dockerfile` (§8)
- [ ] Docker image built and pushed to Artifact Registry (§8)
- [ ] Database migrations run via Cloud Run Job (§14.1)
- [ ] `findemy-api` Cloud Run service deployed (§6.3)
- [ ] `findemy-worker` Cloud Run service deployed (§6.4)
- [ ] Health check passing: `curl https://YOUR_URL/health`
- [ ] `cloudbuild.yaml` committed and Cloud Build trigger wired (§16)
