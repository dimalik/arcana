-- CreateTable
CREATE TABLE "ClaimAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "claimId" TEXT NOT NULL,
    "taskId" TEXT,
    "actorRole" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "confidence" TEXT,
    "notes" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaimAssessment_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ResearchClaim" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClaimAssessment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClaimAssessment_claimId_createdAt_idx" ON "ClaimAssessment"("claimId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimAssessment_taskId_idx" ON "ClaimAssessment"("taskId");

-- CreateIndex
CREATE INDEX "ClaimAssessment_actorRole_createdAt_idx" ON "ClaimAssessment"("actorRole", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimAssessment_verdict_createdAt_idx" ON "ClaimAssessment"("verdict", "createdAt");
