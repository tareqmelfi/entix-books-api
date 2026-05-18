-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "SupplierCreditStatus" AS ENUM ('DRAFT', 'ISSUED', 'APPLIED', 'CANCELLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "SupplierCreditReason" AS ENUM ('RETURN', 'DISCOUNT', 'PRICING_ERROR', 'QUALITY_ISSUE', 'OTHER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'POSTED', 'PAID', 'CANCELLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SupplierCredit" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "originalBillId" TEXT,
    "creditNumber" TEXT NOT NULL,
    "status" "SupplierCreditStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" "SupplierCreditReason" NOT NULL DEFAULT 'RETURN',
    "issueDate" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "exchangeRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SupplierCreditLine" (
    "id" TEXT NOT NULL,
    "supplierCreditId" TEXT NOT NULL,
    "originalBillLineId" TEXT,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRateId" TEXT,
    "subtotal" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "SupplierCreditLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EmployeeContract" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "employeeNumber" TEXT,
    "jobTitle" TEXT,
    "department" TEXT,
    "nationalityCode" TEXT NOT NULL DEFAULT 'SA',
    "iban" TEXT,
    "bankId" TEXT,
    "basicSalary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "housingAllowance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "transportAllowance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "otherAllowances" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sanedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PayrollSetting" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "employerId" TEXT,
    "establishmentId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PayrollRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runNumber" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "grossSalary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "employeeGosi" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "employerGosi" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netSalary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "employerCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "postedJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PayrollLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "contractId" TEXT,
    "nationalityCode" TEXT NOT NULL DEFAULT 'SA',
    "basicSalary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "housingAllowance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "transportAllowance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "otherAllowances" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "grossSalary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "gosiBase" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "employeeGosi" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "employerGosi" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netSalary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "iban" TEXT,
    "bankId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierCredit_orgId_status_idx" ON "SupplierCredit"("orgId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierCredit_orgId_contactId_idx" ON "SupplierCredit"("orgId", "contactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierCredit_orgId_originalBillId_idx" ON "SupplierCredit"("orgId", "originalBillId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierCredit_orgId_creditNumber_key" ON "SupplierCredit"("orgId", "creditNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierCreditLine_supplierCreditId_idx" ON "SupplierCreditLine"("supplierCreditId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierCreditLine_productId_idx" ON "SupplierCreditLine"("productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeeContract_orgId_status_idx" ON "EmployeeContract"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeContract_orgId_contactId_key" ON "EmployeeContract"("orgId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollSetting_orgId_key" ON "PayrollSetting"("orgId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollRun_orgId_period_idx" ON "PayrollRun"("orgId", "period");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollRun_orgId_status_idx" ON "PayrollRun"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollRun_orgId_runNumber_key" ON "PayrollRun"("orgId", "runNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollLine_orgId_employeeId_idx" ON "PayrollLine"("orgId", "employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollLine_payrollRunId_idx" ON "PayrollLine"("payrollRunId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_orgId_entityType_entityId_idx" ON "AuditLog"("orgId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupplierCredit" ADD CONSTRAINT "SupplierCredit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupplierCredit" ADD CONSTRAINT "SupplierCredit_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupplierCredit" ADD CONSTRAINT "SupplierCredit_originalBillId_fkey" FOREIGN KEY ("originalBillId") REFERENCES "Bill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupplierCreditLine" ADD CONSTRAINT "SupplierCreditLine_supplierCreditId_fkey" FOREIGN KEY ("supplierCreditId") REFERENCES "SupplierCredit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupplierCreditLine" ADD CONSTRAINT "SupplierCreditLine_originalBillLineId_fkey" FOREIGN KEY ("originalBillLineId") REFERENCES "BillLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupplierCreditLine" ADD CONSTRAINT "SupplierCreditLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "SupplierCreditLine" ADD CONSTRAINT "SupplierCreditLine_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "EmployeeContract" ADD CONSTRAINT "EmployeeContract_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "EmployeeContract" ADD CONSTRAINT "EmployeeContract_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PayrollSetting" ADD CONSTRAINT "PayrollSetting_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "EmployeeContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
