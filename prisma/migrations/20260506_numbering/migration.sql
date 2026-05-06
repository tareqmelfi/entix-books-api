-- Numbering preferences + custom contact code (idempotent)
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "numberingSettings" JSONB;
ALTER TABLE "Contact"      ADD COLUMN IF NOT EXISTS "customCode"        TEXT;
CREATE INDEX IF NOT EXISTS "Contact_orgId_customCode_idx" ON "Contact"("orgId", "customCode");
