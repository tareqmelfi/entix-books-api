-- Add country/SWIFT/routing fields to BankAccount (idempotent)
ALTER TABLE "BankAccount" ADD COLUMN IF NOT EXISTS "country"       TEXT;
ALTER TABLE "BankAccount" ADD COLUMN IF NOT EXISTS "swiftCode"     TEXT;
ALTER TABLE "BankAccount" ADD COLUMN IF NOT EXISTS "routingNumber" TEXT;
