-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Paper" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "citationCount" INTEGER,
    "readingStatus" TEXT NOT NULL DEFAULT 'unread',
    "isBookmarked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Paper" ("abstract", "arxivId", "authors", "categories", "createdAt", "doi", "filePath", "fullText", "id", "keyFindings", "processingStatus", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "venue", "year") SELECT "abstract", "arxivId", "authors", "categories", "createdAt", "doi", "filePath", "fullText", "id", "keyFindings", "processingStatus", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "venue", "year" FROM "Paper";
DROP TABLE "Paper";
ALTER TABLE "new_Paper" RENAME TO "Paper";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
