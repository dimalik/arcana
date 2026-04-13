ALTER TABLE "ResearchIteration"
ADD COLUMN "nextStepSortOrder" INTEGER NOT NULL DEFAULT 0;

WITH ranked_steps AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "iterationId"
      ORDER BY "sortOrder" ASC, "createdAt" ASC, "id" ASC
    ) - 1 AS "newSortOrder"
  FROM "ResearchStep"
)
UPDATE "ResearchStep"
SET "sortOrder" = (
  SELECT "newSortOrder"
  FROM ranked_steps
  WHERE ranked_steps."id" = "ResearchStep"."id"
)
WHERE "id" IN (SELECT "id" FROM ranked_steps);

UPDATE "ResearchIteration"
SET "nextStepSortOrder" = COALESCE((
  SELECT MAX("sortOrder") + 1
  FROM "ResearchStep"
  WHERE "ResearchStep"."iterationId" = "ResearchIteration"."id"
), 0);

CREATE UNIQUE INDEX "ResearchStep_iterationId_sortOrder_key"
ON "ResearchStep"("iterationId", "sortOrder");
