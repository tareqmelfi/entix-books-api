-- UX-181 · separate print logo from avatar logo (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Organization' AND column_name='printLogoUrl') THEN
    ALTER TABLE "Organization" ADD COLUMN "printLogoUrl" TEXT;
  END IF;
END $$;
