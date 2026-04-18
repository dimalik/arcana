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
    "entityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Paper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Paper_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "PaperEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Paper" ("abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "engagementScore", "entityId", "filePath", "fullText", "id", "isLiked", "isResearchOnly", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "userId", "venue", "year") SELECT "abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "engagementScore", "entityId", "filePath", "fullText", "id", "isLiked", "isResearchOnly", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "userId", "venue", "year" FROM "Paper";
DROP TABLE "Paper";
ALTER TABLE "new_Paper" RENAME TO "Paper";
CREATE UNIQUE INDEX "Paper_userId_entityId_key" ON "Paper"("userId", "entityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
