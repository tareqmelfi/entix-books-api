-- Expense receipt metadata and supplier linking
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "contactId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "documentNumber" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attachmentName" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attachmentType" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attachmentSizeBytes" INTEGER;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attachmentBase64" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "attachmentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "lineItems" JSONB;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "extractedJson" JSONB;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "ocrConfidence" DECIMAL(5,4);
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "duplicateOfId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "duplicateReason" TEXT;

UPDATE "Expense"
SET "subtotal" = "amount"
WHERE "subtotal" = 0;

CREATE INDEX IF NOT EXISTS "Expense_orgId_contactId_idx" ON "Expense"("orgId", "contactId");
CREATE INDEX IF NOT EXISTS "Expense_orgId_documentNumber_idx" ON "Expense"("orgId", "documentNumber");

DO $$ BEGIN
  ALTER TABLE "Expense"
    ADD CONSTRAINT "Expense_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
