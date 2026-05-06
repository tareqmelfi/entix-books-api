-- Org branding + address + tax registration fields (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'stampUrl') THEN
    ALTER TABLE "Organization" ADD COLUMN "stampUrl" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'addressLine') THEN
    ALTER TABLE "Organization" ADD COLUMN "addressLine" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'city') THEN
    ALTER TABLE "Organization" ADD COLUMN "city" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'region') THEN
    ALTER TABLE "Organization" ADD COLUMN "region" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'postalCode') THEN
    ALTER TABLE "Organization" ADD COLUMN "postalCode" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'district') THEN
    ALTER TABLE "Organization" ADD COLUMN "district" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'buildingNumber') THEN
    ALTER TABLE "Organization" ADD COLUMN "buildingNumber" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'streetName') THEN
    ALTER TABLE "Organization" ADD COLUMN "streetName" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'industry') THEN
    ALTER TABLE "Organization" ADD COLUMN "industry" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'taxRegistrationDate') THEN
    ALTER TABLE "Organization" ADD COLUMN "taxRegistrationDate" TIMESTAMP(3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'firstVatPeriodStart') THEN
    ALTER TABLE "Organization" ADD COLUMN "firstVatPeriodStart" TIMESTAMP(3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'vatPeriod') THEN
    ALTER TABLE "Organization" ADD COLUMN "vatPeriod" TEXT;
  END IF;
END $$;
