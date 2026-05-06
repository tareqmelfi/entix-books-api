-- Org contact info + US address fields + fiscal year end (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'email') THEN
    ALTER TABLE "Organization" ADD COLUMN "email" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'phone') THEN
    ALTER TABLE "Organization" ADD COLUMN "phone" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'website') THEN
    ALTER TABLE "Organization" ADD COLUMN "website" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'fiscalYearEnd') THEN
    ALTER TABLE "Organization" ADD COLUMN "fiscalYearEnd" INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'suiteUnit') THEN
    ALTER TABLE "Organization" ADD COLUMN "suiteUnit" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'state') THEN
    ALTER TABLE "Organization" ADD COLUMN "state" TEXT;
  END IF;
END $$;
