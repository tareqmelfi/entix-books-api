-- Unified contacts: a Person can be customer/supplier/employee/shareholder simultaneously (#46)
-- Country-aware fields (#47) + foreign-entity withholding tax support

-- 1. Add new role flags
ALTER TABLE "Contact" ADD COLUMN "isCustomer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "isSupplier" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "isEmployee" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "isShareholder" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "isFreelancer" BOOLEAN NOT NULL DEFAULT false;

-- 2. Add entity-kind enum + column
DO $$ BEGIN
    CREATE TYPE "ContactEntityKind" AS ENUM ('INDIVIDUAL', 'COMPANY');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Contact" ADD COLUMN "entityKind" "ContactEntityKind" NOT NULL DEFAULT 'COMPANY';

-- 3. Foreign-entity + withholding tax + LEI + default currency (#47)
ALTER TABLE "Contact" ADD COLUMN "taxId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "nationalId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "isForeign" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "leiCode" TEXT;
ALTER TABLE "Contact" ADD COLUMN "withholdingTaxRate" DECIMAL(5, 2);
ALTER TABLE "Contact" ADD COLUMN "defaultCurrency" VARCHAR(3);

-- 4. CRM-light fields
ALTER TABLE "Contact" ADD COLUMN "tags" TEXT;
ALTER TABLE "Contact" ADD COLUMN "lastInteraction" TIMESTAMP(3);

-- 5. Backfill role flags from existing type enum
UPDATE "Contact" SET "isCustomer" = true WHERE "type" IN ('CUSTOMER', 'BOTH');
UPDATE "Contact" SET "isSupplier" = true WHERE "type" IN ('SUPPLIER', 'BOTH');

-- 6. Backfill taxId from vatNumber for KSA contacts
UPDATE "Contact" SET "taxId" = "vatNumber" WHERE "vatNumber" IS NOT NULL AND "taxId" IS NULL;

-- 7. Mark non-SA contacts as foreign by default
UPDATE "Contact" SET "isForeign" = true WHERE "country" IS NOT NULL AND "country" != 'SA';

-- 8. Indexes for role-filtered queries
CREATE INDEX "Contact_orgId_isCustomer_idx" ON "Contact"("orgId", "isCustomer");
CREATE INDEX "Contact_orgId_isSupplier_idx" ON "Contact"("orgId", "isSupplier");
CREATE INDEX "Contact_orgId_isEmployee_idx" ON "Contact"("orgId", "isEmployee");
CREATE INDEX "Contact_orgId_country_idx" ON "Contact"("orgId", "country");
