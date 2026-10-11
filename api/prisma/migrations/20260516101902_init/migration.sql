-- CreateEnum
CREATE TYPE "Category" AS ENUM ('music', 'dance', 'arts', 'yoga');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('open', 'full', 'past');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('initiated', 'paid', 'confirmed', 'cancelled', 'rescheduled');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('initiated', 'pending', 'captured', 'failed');

-- CreateEnum
CREATE TYPE "TrialStatus" AS ENUM ('booked', 'attended', 'missed', 'cancelled');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('competition', 'talent_hunt', 'meetup');

-- CreateEnum
CREATE TYPE "WorkshopType" AS ENUM ('online', 'offline', 'masterclass', 'demo');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "SubjectRole" AS ENUM ('student', 'academy');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'paid', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "age" INTEGER,
    "location" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "interests" "Category"[],
    "avatarInitial" VARCHAR(2) NOT NULL,
    "attendanceOtp" VARCHAR(6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_accounts" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "onlineAvailable" BOOLEAN NOT NULL DEFAULT false,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "bio" TEXT,
    "bankAccountId" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "bankHolderName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coaches" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "bio" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coaches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "level" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "trialFeePaise" INTEGER NOT NULL,
    "monthlyFeePaise" INTEGER NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_timings" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" VARCHAR(5) NOT NULL,
    "durationMin" INTEGER NOT NULL,

    CONSTRAINT "batch_timings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slots" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "slotTime" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "SlotStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'initiated',
    "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
    "reservationExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "razorpayOrderId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'initiated',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "trialAt" TIMESTAMP(3) NOT NULL,
    "status" "TrialStatus" NOT NULL DEFAULT 'booked',
    "attendanceMarkedAt" TIMESTAMP(3),
    "attendanceMarkedByAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "trialId" TEXT NOT NULL,
    "rating" SMALLINT NOT NULL,
    "comment" TEXT,
    "response" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "title" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "description" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "capacity" INTEGER,
    "enrolledCount" INTEGER NOT NULL DEFAULT 0,
    "organizerName" TEXT NOT NULL,
    "coverColor" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshops" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "type" "WorkshopType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "location" TEXT,
    "capacity" INTEGER NOT NULL,
    "registeredCount" INTEGER NOT NULL DEFAULT 0,
    "pricePaise" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workshops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_attendances" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "present" BOOLEAN NOT NULL,
    "markedByAccountId" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectRole" "SubjectRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expo_push_tokens" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectRole" "SubjectRole" NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expo_push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_requests" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "SubjectRole" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_settings" (
    "accountId" TEXT NOT NULL,
    "notificationsNewTrial" BOOLEAN NOT NULL DEFAULT true,
    "notificationsReview" BOOLEAN NOT NULL DEFAULT true,
    "privacyShowPhone" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "academy_settings_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_lat_lng_idx" ON "users"("lat", "lng");

-- CreateIndex
CREATE UNIQUE INDEX "academy_accounts_phone_key" ON "academy_accounts"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "academy_accounts_academyId_key" ON "academy_accounts"("academyId");

-- CreateIndex
CREATE INDEX "academies_category_rating_idx" ON "academies"("category", "rating");

-- CreateIndex
CREATE INDEX "academies_lat_lng_idx" ON "academies"("lat", "lng");

-- CreateIndex
CREATE INDEX "coaches_academyId_idx" ON "coaches"("academyId");

-- CreateIndex
CREATE INDEX "batches_academyId_status_idx" ON "batches"("academyId", "status");

-- CreateIndex
CREATE INDEX "batch_timings_batchId_idx" ON "batch_timings"("batchId");

-- CreateIndex
CREATE INDEX "slots_batchId_slotTime_idx" ON "slots"("batchId", "slotTime");

-- CreateIndex
CREATE INDEX "bookings_userId_status_idx" ON "bookings"("userId", "status");

-- CreateIndex
CREATE INDEX "bookings_slotId_status_idx" ON "bookings"("slotId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_bookingId_key" ON "payments"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_razorpayOrderId_key" ON "payments"("razorpayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "trials_bookingId_key" ON "trials"("bookingId");

-- CreateIndex
CREATE INDEX "trials_userId_status_idx" ON "trials"("userId", "status");

-- CreateIndex
CREATE INDEX "trials_academyId_status_trialAt_idx" ON "trials"("academyId", "status", "trialAt");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_trialId_key" ON "reviews"("trialId");

-- CreateIndex
CREATE INDEX "reviews_academyId_createdAt_idx" ON "reviews"("academyId", "createdAt");

-- CreateIndex
CREATE INDEX "events_type_startAt_idx" ON "events"("type", "startAt");

-- CreateIndex
CREATE INDEX "workshops_academyId_startAt_idx" ON "workshops"("academyId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_userId_batchId_key" ON "enrollments"("userId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_attendances_batchId_userId_date_key" ON "batch_attendances"("batchId", "userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_subjectId_subjectRole_idx" ON "refresh_tokens"("subjectId", "subjectRole");

-- CreateIndex
CREATE UNIQUE INDEX "expo_push_tokens_token_key" ON "expo_push_tokens"("token");

-- CreateIndex
CREATE INDEX "expo_push_tokens_subjectId_subjectRole_idx" ON "expo_push_tokens"("subjectId", "subjectRole");

-- CreateIndex
CREATE INDEX "otp_requests_phone_createdAt_idx" ON "otp_requests"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "otp_requests_expiresAt_idx" ON "otp_requests"("expiresAt");

-- CreateIndex
CREATE INDEX "payouts_academyId_createdAt_idx" ON "payouts"("academyId", "createdAt");

-- AddForeignKey
ALTER TABLE "academy_accounts" ADD CONSTRAINT "academy_accounts_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaches" ADD CONSTRAINT "coaches_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "coaches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_timings" ADD CONSTRAINT "batch_timings_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trialId_fkey" FOREIGN KEY ("trialId") REFERENCES "trials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workshops" ADD CONSTRAINT "workshops_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "academies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_attendances" ADD CONSTRAINT "batch_attendances_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_attendances" ADD CONSTRAINT "batch_attendances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "rt_user_fk" FOREIGN KEY ("subjectId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expo_push_tokens" ADD CONSTRAINT "pt_user_fk" FOREIGN KEY ("subjectId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
