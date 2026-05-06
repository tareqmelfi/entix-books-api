-- Wafeq-style account fields: cash flow type + 3 allow flags + system flag (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Account' AND column_name = 'cashFlowType') THEN
    ALTER TABLE "Account" ADD COLUMN "cashFlowType" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Account' AND column_name = 'allowPosting') THEN
    ALTER TABLE "Account" ADD COLUMN "allowPosting" BOOLEAN NOT NULL DEFAULT true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Account' AND column_name = 'allowPayment') THEN
    ALTER TABLE "Account" ADD COLUMN "allowPayment" BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Account' AND column_name = 'allowExpenseClaim') THEN
    ALTER TABLE "Account" ADD COLUMN "allowExpenseClaim" BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Account' AND column_name = 'isSystemAccount') THEN
    ALTER TABLE "Account" ADD COLUMN "isSystemAccount" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
