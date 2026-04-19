-- CreateTable
CREATE TABLE "PaperDuplicateCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "winnerPaperId" TEXT NOT NULL,
    "loserPaperId" TEXT NOT NULL,
    "duplicateClass" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "chosenAction" TEXT,
    "autoSafeCollapse" BOOLEAN NOT NULL DEFAULT false,
    "canonicalEntityCollision" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" DATETIME,
    "appliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperDuplicateCandidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperDuplicateCandidate_winnerPaperId_fkey" FOREIGN KEY ("winnerPaperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperDuplicateCandidate_loserPaperId_fkey" FOREIGN KEY ("loserPaperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Paper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "abstract" TEXT,
    "authors" TEXT,
    "year" INTEGER,
    "venue" TEXT,
    "doi" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'UPLOAD',
    "sourceUrl" TEXT,
    "arxivId" TEXT,
    "filePath" TEXT,
    "fullText" TEXT,
    "summary" TEXT,
    "keyFindings" TEXT,
    "categories" TEXT,
    "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "processingStep" TEXT,
    "processingStartedAt" DATETIME,
    "referenceState" TEXT NOT NULL DEFAULT 'pending',
    "citationCount" INTEGER,
    "isLiked" BOOLEAN NOT NULL DEFAULT false,
    "isResearchOnly" BOOLEAN NOT NULL DEFAULT false,
    "engagementScore" REAL NOT NULL DEFAULT 0,
    "duplicateState" TEXT NOT NULL DEFAULT 'ACTIVE',
    "collapsedIntoPaperId" TEXT,
    "entityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Paper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Paper_collapsedIntoPaperId_fkey" FOREIGN KEY ("collapsedIntoPaperId") REFERENCES "Paper" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Paper_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "PaperEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Paper" ("abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "engagementScore", "entityId", "filePath", "fullText", "id", "isLiked", "isResearchOnly", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "referenceState", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "userId", "venue", "year") SELECT "abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "engagementScore", "entityId", "filePath", "fullText", "id", "isLiked", "isResearchOnly", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "referenceState", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "userId", "venue", "year" FROM "Paper";
DROP TABLE "Paper";
ALTER TABLE "new_Paper" RENAME TO "Paper";
CREATE INDEX "Paper_userId_duplicateState_idx" ON "Paper"("userId", "duplicateState");
CREATE INDEX "Paper_collapsedIntoPaperId_idx" ON "Paper"("collapsedIntoPaperId");
CREATE UNIQUE INDEX "Paper_userId_entityId_key" ON "Paper"("userId", "entityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PaperDuplicateCandidate_userId_reviewStatus_idx" ON "PaperDuplicateCandidate"("userId", "reviewStatus");

-- CreateIndex
CREATE INDEX "PaperDuplicateCandidate_userId_duplicateClass_idx" ON "PaperDuplicateCandidate"("userId", "duplicateClass");

-- CreateIndex
CREATE INDEX "PaperDuplicateCandidate_loserPaperId_idx" ON "PaperDuplicateCandidate"("loserPaperId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperDuplicateCandidate_winnerPaperId_loserPaperId_key" ON "PaperDuplicateCandidate"("winnerPaperId", "loserPaperId");
