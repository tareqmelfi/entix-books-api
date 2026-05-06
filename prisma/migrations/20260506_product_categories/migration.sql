-- Product categories + new types (idempotent)
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "category"     TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "billingCycle" TEXT;
CREATE INDEX IF NOT EXISTS "Product_orgId_category_idx" ON "Product"("orgId", "category");

-- Extend ProductType enum (Postgres needs ALTER TYPE ADD VALUE IF NOT EXISTS)
DO $$ BEGIN
  ALTER TYPE "ProductType" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION';
EXCEPTION WHEN others THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE "ProductType" ADD VALUE IF NOT EXISTS 'PACKAGE';
EXCEPTION WHEN others THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE "ProductType" ADD VALUE IF NOT EXISTS 'BUNDLE';
EXCEPTION WHEN others THEN null; END $$;
DO $$ BEGIN
  ALTER TYPE "ProductType" ADD VALUE IF NOT EXISTS 'DIGITAL';
EXCEPTION WHEN others THEN null; END $$;
