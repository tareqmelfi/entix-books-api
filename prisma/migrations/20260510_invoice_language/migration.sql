-- UX-183 · default invoice language per org (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Organization' AND column_name='defaultInvoiceLanguage') THEN
    ALTER TABLE "Organization" ADD COLUMN "defaultInvoiceLanguage" TEXT DEFAULT 'ar';
  END IF;
END $$;
