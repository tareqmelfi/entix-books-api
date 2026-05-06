-- Payment links columns on Invoice (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Invoice' AND column_name = 'paymentLinkUrl') THEN
    ALTER TABLE "Invoice" ADD COLUMN "paymentLinkUrl" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Invoice' AND column_name = 'paymentLinkProvider') THEN
    ALTER TABLE "Invoice" ADD COLUMN "paymentLinkProvider" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Invoice' AND column_name = 'paymentLinkId') THEN
    ALTER TABLE "Invoice" ADD COLUMN "paymentLinkId" TEXT;
  END IF;
END $$;
