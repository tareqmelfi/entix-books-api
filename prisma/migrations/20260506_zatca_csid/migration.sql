-- ZATCA Phase 2 · CSID + ICV + PIH columns on Organization
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'zatcaCsid') THEN
    ALTER TABLE "Organization" ADD COLUMN "zatcaCsid" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'zatcaCsidSecret') THEN
    ALTER TABLE "Organization" ADD COLUMN "zatcaCsidSecret" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'zatcaMode') THEN
    ALTER TABLE "Organization" ADD COLUMN "zatcaMode" TEXT DEFAULT 'sandbox';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'zatcaIcv') THEN
    ALTER TABLE "Organization" ADD COLUMN "zatcaIcv" INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'zatcaPih') THEN
    ALTER TABLE "Organization" ADD COLUMN "zatcaPih" TEXT;
  END IF;
END $$;
