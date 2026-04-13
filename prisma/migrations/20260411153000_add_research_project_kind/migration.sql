ALTER TABLE "ResearchProject"
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'RESEARCH';

UPDATE "ResearchProject"
SET "kind" = 'SYSTEM'
WHERE "title" IN (
  'Agent Mock E2E',
  'Superpowers Acceptance (Auto)',
  'Credibility Acceptance (Auto)',
  'CI Superpowers Acceptance'
);

CREATE INDEX "ResearchProject_userId_kind_updatedAt_idx"
ON "ResearchProject"("userId", "kind", "updatedAt");
