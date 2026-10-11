-- Multi-ticket workshop / meetup bookings, and family participants for competitions.
--
-- A registration stays one per account per workshop or event, and now carries `quantity`
-- tickets (1–6) with one attendee row per ticket. Competition attendees are family learners
-- (learnerId); meetup and workshop tickets are typed names. Payments remember the quantity they
-- were priced for so a capture confirms exactly what was paid for.

-- AlterTable
ALTER TABLE "event_payments" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "event_registrations" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "workshop_payments" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "workshop_registrations" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "workshop_attendees" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workshop_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_attendees" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "learnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workshop_attendees_registrationId_position_key" ON "workshop_attendees"("registrationId", "position");

-- CreateIndex
CREATE INDEX "event_attendees_learnerId_idx" ON "event_attendees"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "event_attendees_registrationId_position_key" ON "event_attendees"("registrationId", "position");

-- AddForeignKey
ALTER TABLE "workshop_attendees" ADD CONSTRAINT "workshop_attendees_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "workshop_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "event_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "learners"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: every existing registration was a single ticket for the account holder.
INSERT INTO "workshop_attendees" ("id", "registrationId", "name", "position", "createdAt")
SELECT 'att' || replace(gen_random_uuid()::text, '-', ''), r.id, COALESCE(u.name, ''), 0, r."createdAt"
FROM "workshop_registrations" r JOIN "users" u ON u.id = r."userId";

INSERT INTO "event_attendees" ("id", "registrationId", "name", "position", "learnerId", "createdAt")
SELECT 'att' || replace(gen_random_uuid()::text, '-', ''), r.id, COALESCE(u.name, ''), 0,
       CASE WHEN e.type = 'competition' THEN u."selfLearnerId" ELSE NULL END, r."createdAt"
FROM "event_registrations" r
JOIN "users" u ON u.id = r."userId"
JOIN "events" e ON e.id = r."eventId";
