-- Idempotent migration for JournalAttachment table
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'JournalAttachment'
  ) THEN
    CREATE TABLE "JournalAttachment" (
      "id" TEXT NOT NULL,
      "journalId" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "contentType" TEXT NOT NULL,
      "sizeBytes" INTEGER NOT NULL,
      "url" TEXT NOT NULL,
      "uploadedBy" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "JournalAttachment_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "JournalAttachment_journalId_idx" ON "JournalAttachment"("journalId");
    ALTER TABLE "JournalAttachment"
      ADD CONSTRAINT "JournalAttachment_journalId_fkey"
      FOREIGN KEY ("journalId") REFERENCES "JournalEntry"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
