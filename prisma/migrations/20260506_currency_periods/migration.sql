-- Multi-currency rates + fiscal periods (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'CurrencyRate') THEN
    CREATE TABLE "CurrencyRate" (
      "id" TEXT NOT NULL,
      "orgId" TEXT,
      "fromCurrency" TEXT NOT NULL,
      "toCurrency" TEXT NOT NULL,
      "rate" DECIMAL(20, 10) NOT NULL,
      "date" TIMESTAMP(3) NOT NULL,
      "source" TEXT NOT NULL DEFAULT 'manual',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CurrencyRate_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "CurrencyRate_unique"
      ON "CurrencyRate"("orgId","fromCurrency","toCurrency","date");
    CREATE INDEX "CurrencyRate_lookup"
      ON "CurrencyRate"("fromCurrency","toCurrency","date");
  END IF;

  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'FiscalPeriod') THEN
    CREATE TABLE "FiscalPeriod" (
      "id" TEXT NOT NULL,
      "orgId" TEXT NOT NULL,
      "fiscalYear" INTEGER NOT NULL,
      "periodNumber" INTEGER NOT NULL,
      "startDate" TIMESTAMP(3) NOT NULL,
      "endDate" TIMESTAMP(3) NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "lockedAt" TIMESTAMP(3),
      "closedAt" TIMESTAMP(3),
      "closedBy" TEXT,
      "retainedEarnings" DECIMAL(20, 4),
      "totalRevenue" DECIMAL(20, 4),
      "totalExpense" DECIMAL(20, 4),
      "netIncome" DECIMAL(20, 4),
      "notes" TEXT,
      CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "FiscalPeriod_unique"
      ON "FiscalPeriod"("orgId","fiscalYear","periodNumber");
    CREATE INDEX "FiscalPeriod_status"
      ON "FiscalPeriod"("orgId","status");
    ALTER TABLE "FiscalPeriod"
      ADD CONSTRAINT "FiscalPeriod_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
