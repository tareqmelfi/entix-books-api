-- Multi-warehouse inventory · WAC/FIFO/LIFO (#59)

DO $$ BEGIN
    CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT','ISSUE','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT','OPENING','RETURN_IN','RETURN_OUT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Warehouse_orgId_code_key" ON "Warehouse"("orgId", "code");
CREATE INDEX "Warehouse_orgId_isActive_idx" ON "Warehouse"("orgId", "isActive");
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "averageCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lastCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockLevel_productId_warehouseId_key" ON "StockLevel"("productId", "warehouseId");
CREATE INDEX "StockLevel_orgId_productId_idx" ON "StockLevel"("orgId", "productId");
CREATE INDEX "StockLevel_orgId_warehouseId_idx" ON "StockLevel"("orgId", "warehouseId");
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "refType" TEXT,
    "refId" TEXT,
    "notes" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StockMovement_orgId_productId_occurredAt_idx" ON "StockMovement"("orgId", "productId", "occurredAt");
CREATE INDEX "StockMovement_orgId_warehouseId_occurredAt_idx" ON "StockMovement"("orgId", "warehouseId", "occurredAt");
CREATE INDEX "StockMovement_refType_refId_idx" ON "StockMovement"("refType", "refId");
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
