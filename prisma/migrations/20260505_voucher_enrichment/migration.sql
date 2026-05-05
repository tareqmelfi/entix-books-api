-- Voucher enrichment (#45): bank account · advance payment · project · cost center · attachment

ALTER TABLE "Voucher" ADD COLUMN "bankAccountId" TEXT;
ALTER TABLE "Voucher" ADD COLUMN "isAdvance" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Voucher" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Voucher" ADD COLUMN "costCenterId" TEXT;
ALTER TABLE "Voucher" ADD COLUMN "attachmentUrl" TEXT;

ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_costCenterId_fkey"
    FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Voucher_orgId_bankAccountId_idx" ON "Voucher"("orgId", "bankAccountId");
CREATE INDEX "Voucher_orgId_isAdvance_idx" ON "Voucher"("orgId", "isAdvance");
CREATE INDEX "Voucher_orgId_contactId_idx" ON "Voucher"("orgId", "contactId");
