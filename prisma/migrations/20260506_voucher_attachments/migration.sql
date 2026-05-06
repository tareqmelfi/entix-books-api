-- VoucherAttachment table (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'VoucherAttachment') THEN
    CREATE TABLE "VoucherAttachment" (
      "id" TEXT NOT NULL,
      "voucherId" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "contentType" TEXT NOT NULL,
      "sizeBytes" INTEGER NOT NULL,
      "url" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "VoucherAttachment_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "VoucherAttachment_voucherId_idx" ON "VoucherAttachment"("voucherId");
    ALTER TABLE "VoucherAttachment"
      ADD CONSTRAINT "VoucherAttachment_voucherId_fkey"
      FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
