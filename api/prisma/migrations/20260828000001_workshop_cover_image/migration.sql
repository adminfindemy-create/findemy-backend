-- Workshops had no artwork of their own: both apps fell back to a generated block-print cover
-- (academy) or a stock photo keyed by type (student), so every workshop of the same type looked
-- identical. Nullable — a workshop without a cover keeps the existing fallback.
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "coverImageUrl" TEXT;
