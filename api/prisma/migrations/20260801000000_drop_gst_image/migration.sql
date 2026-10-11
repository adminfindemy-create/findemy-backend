-- The GST certificate photo is gone from KYC: PAN + Aadhaar images already establish identity, and
-- a GST number is verifiable against the government registry without an image — so this column was
-- storing a document nobody reads. The GST NUMBER stays.
ALTER TABLE "academies" DROP COLUMN IF EXISTS "gstImageUrl";
