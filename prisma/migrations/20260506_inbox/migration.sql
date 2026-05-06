-- Inbox · email-to-invoice · UX-81 (idempotent)

DO $$ BEGIN
  CREATE TYPE "InboxStatus" AS ENUM ('RECEIVED', 'EXTRACTED', 'APPROVED', 'REJECTED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "InboxMessage" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "fromAddress" TEXT NOT NULL,
  "toAddress" TEXT NOT NULL,
  "subject" TEXT NOT NULL DEFAULT '',
  "bodyText" TEXT NOT NULL DEFAULT '',
  "bodyHtml" TEXT NOT NULL DEFAULT '',
  "messageId" TEXT,
  "status" "InboxStatus" NOT NULL DEFAULT 'RECEIVED',
  "attachmentCount" INTEGER NOT NULL DEFAULT 0,
  "extractedJson" JSONB,
  "extractedKind" TEXT,
  "extractedTotal" DECIMAL(15,2),
  "extractedCurrency" TEXT,
  "billId" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InboxAttachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "contentBase64" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboxAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InboxMessage_orgId_status_idx" ON "InboxMessage"("orgId", "status");
CREATE INDEX IF NOT EXISTS "InboxMessage_orgId_createdAt_idx" ON "InboxMessage"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "InboxAttachment_messageId_idx" ON "InboxAttachment"("messageId");

DO $$ BEGIN
  ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "InboxAttachment" ADD CONSTRAINT "InboxAttachment_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "InboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
