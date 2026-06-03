-- Persistent AI assistant conversations
CREATE TABLE IF NOT EXISTS "AiConversation" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT 'محادثة جديدة',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "userId" TEXT,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "toolResults" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiConversation_orgId_userId_lastMessageAt_idx"
  ON "AiConversation"("orgId", "userId", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "AiConversation_orgId_status_lastMessageAt_idx"
  ON "AiConversation"("orgId", "status", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "AiMessage_conversationId_createdAt_idx"
  ON "AiMessage"("conversationId", "createdAt");

CREATE INDEX IF NOT EXISTS "AiMessage_orgId_createdAt_idx"
  ON "AiMessage"("orgId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "AiConversation"
    ADD CONSTRAINT "AiConversation_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "AiConversation"
    ADD CONSTRAINT "AiConversation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "AiMessage"
    ADD CONSTRAINT "AiMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "AiMessage"
    ADD CONSTRAINT "AiMessage_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "AiMessage"
    ADD CONSTRAINT "AiMessage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
