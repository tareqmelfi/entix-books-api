ALTER TABLE "Contact"
  ADD COLUMN IF NOT EXISTS "shortCode" VARCHAR(4);

WITH candidates AS (
  SELECT
    id,
    "orgId",
    substring(upper("customCode") from '-([A-Z0-9]{1,4})$') AS candidate
  FROM "Contact"
  WHERE "shortCode" IS NULL
    AND "customCode" IS NOT NULL
),
unique_candidates AS (
  SELECT
    id,
    "orgId",
    candidate,
    count(*) OVER (PARTITION BY "orgId", candidate) AS duplicate_count
  FROM candidates
  WHERE candidate IS NOT NULL
    AND candidate ~ '[A-Z]'
)
UPDATE "Contact" c
SET "shortCode" = u.candidate
FROM unique_candidates u
WHERE c.id = u.id
  AND u.duplicate_count = 1;

CREATE UNIQUE INDEX IF NOT EXISTS "Contact_orgId_shortCode_key"
  ON "Contact"("orgId", "shortCode");
