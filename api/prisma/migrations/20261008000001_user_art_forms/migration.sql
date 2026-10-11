-- Specific art forms a student wants to pursue within their chosen categories ("guitar",
-- "kathak"), picked on the signup interests screen. Keys come from the `ART_FORMS` catalogue in
-- @findemy/types; stored as text so adding or retiring an art form needs no migration.
ALTER TABLE "users" ADD COLUMN "artForms" TEXT[] DEFAULT ARRAY[]::TEXT[];
