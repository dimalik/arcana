-- CreateTable
CREATE TABLE "Reference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT,
    "year" INTEGER,
    "venue" TEXT,
    "doi" TEXT,
    "rawCitation" TEXT NOT NULL,
    "referenceIndex" INTEGER,
    "matchedPaperId" TEXT,
    "matchConfidence" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Reference_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Reference_matchedPaperId_fkey" FOREIGN KEY ("matchedPaperId") REFERENCES "Paper" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
