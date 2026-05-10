-- UX-181 · invoice exchangeRate (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Invoice' AND column_name='exchangeRate') THEN
    ALTER TABLE "Invoice" ADD COLUMN "exchangeRate" DECIMAL(18,6);
  END IF;
END $$;
