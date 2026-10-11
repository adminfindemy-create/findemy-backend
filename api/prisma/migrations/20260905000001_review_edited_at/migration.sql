-- Students can now rewrite a review they already left (previously the only way to change one
-- was to delete it and post again). `editedAt` marks a review that has been rewritten so the
-- student app can label it; NULL means never edited. Deliberately not `@updatedAt`: an academy
-- posting a reply writes to this row too, and that must not make the review read as edited.
ALTER TABLE "reviews" ADD COLUMN "editedAt" TIMESTAMP(3);
