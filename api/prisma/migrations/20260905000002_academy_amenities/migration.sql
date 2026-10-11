-- Branch-level amenities (parking, lift, washroom, …), shown as an icon grid on the student
-- academy page and edited by the owner in the studio profile screen. Keys come from the fixed
-- `AMENITIES` catalogue in @findemy/types; stored as text so retiring a key needs no migration.
ALTER TABLE "academies" ADD COLUMN "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[];
