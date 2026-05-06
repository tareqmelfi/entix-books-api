-- Customer/Supplier portal + CRM-light fields on Contact (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Contact' AND column_name = 'creditLimit') THEN
    ALTER TABLE "Contact" ADD COLUMN "creditLimit" DECIMAL(18, 2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Contact' AND column_name = 'paymentTerms') THEN
    ALTER TABLE "Contact" ADD COLUMN "paymentTerms" INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Contact' AND column_name = 'portalToken') THEN
    ALTER TABLE "Contact" ADD COLUMN "portalToken" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "Contact_portalToken_key" ON "Contact"("portalToken");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Contact' AND column_name = 'portalEnabled') THEN
    ALTER TABLE "Contact" ADD COLUMN "portalEnabled" BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Contact' AND column_name = 'lifetimeValue') THEN
    ALTER TABLE "Contact" ADD COLUMN "lifetimeValue" DECIMAL(18, 2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Contact' AND column_name = 'riskScore') THEN
    ALTER TABLE "Contact" ADD COLUMN "riskScore" INTEGER;
  END IF;
END $$;
