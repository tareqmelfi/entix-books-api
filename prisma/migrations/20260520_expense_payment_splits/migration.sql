-- Store split payments for one expense receipt (cash + card, bank + cash, etc.)
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "paymentSplits" JSONB;
