-- CreateTable
CREATE TABLE "SourceCapabilityEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceCapabilityEvaluation_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CapabilitySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "snapshotVersion" TEXT NOT NULL,
    "coverageClass" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CapabilitySnapshot_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CapabilitySnapshotEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilitySnapshotId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceCapabilityEvaluationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CapabilitySnapshotEntry_capabilitySnapshotId_fkey" FOREIGN KEY ("capabilitySnapshotId") REFERENCES "CapabilitySnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CapabilitySnapshotEntry_sourceCapabilityEvaluationId_fkey" FOREIGN KEY ("sourceCapabilityEvaluationId") REFERENCES "SourceCapabilityEvaluation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ExtractionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "capabilitySnapshotId" TEXT,
    "extractorVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ExtractionRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExtractionRun_capabilitySnapshotId_fkey" FOREIGN KEY ("capabilitySnapshotId") REFERENCES "CapabilitySnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ExtractionRun" ("completedAt", "createdAt", "extractorVersion", "id", "metadata", "paperId", "status") SELECT "completedAt", "createdAt", "extractorVersion", "id", "metadata", "paperId", "status" FROM "ExtractionRun";
DROP TABLE "ExtractionRun";
ALTER TABLE "new_ExtractionRun" RENAME TO "ExtractionRun";
CREATE INDEX "ExtractionRun_paperId_createdAt_idx" ON "ExtractionRun"("paperId", "createdAt");
CREATE INDEX "ExtractionRun_capabilitySnapshotId_idx" ON "ExtractionRun"("capabilitySnapshotId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SourceCapabilityEvaluation_paperId_source_checkedAt_idx" ON "SourceCapabilityEvaluation"("paperId", "source", "checkedAt");

-- CreateIndex
CREATE INDEX "CapabilitySnapshot_paperId_createdAt_idx" ON "CapabilitySnapshot"("paperId", "createdAt");

-- CreateIndex
CREATE INDEX "CapabilitySnapshotEntry_sourceCapabilityEvaluationId_idx" ON "CapabilitySnapshotEntry"("sourceCapabilityEvaluationId");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilitySnapshotEntry_capabilitySnapshotId_source_key" ON "CapabilitySnapshotEntry"("capabilitySnapshotId", "source");
