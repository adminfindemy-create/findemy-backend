-- CreateTable
CREATE TABLE "workshop_registrations" (
    "id" TEXT NOT NULL,
    "workshopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workshop_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshop_payments" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "razorpayOrderId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'initiated',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "workshop_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workshop_registrations_workshopId_userId_key" ON "workshop_registrations"("workshopId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "workshop_payments_registrationId_key" ON "workshop_payments"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "workshop_payments_razorpayOrderId_key" ON "workshop_payments"("razorpayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "workshop_payments_idempotencyKey_key" ON "workshop_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "workshop_payments_status_idx" ON "workshop_payments"("status");

-- AddForeignKey
ALTER TABLE "workshop_registrations" ADD CONSTRAINT "workshop_registrations_workshopId_fkey" FOREIGN KEY ("workshopId") REFERENCES "workshops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workshop_registrations" ADD CONSTRAINT "workshop_registrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workshop_payments" ADD CONSTRAINT "workshop_payments_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "workshop_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
