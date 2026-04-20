-- CreateTable
CREATE TABLE "Author" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "orcid" TEXT,
    "semanticScholarAuthorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PaperAuthor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "rawName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperAuthor_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperAuthor_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Author_normalizedName_key" ON "Author"("normalizedName");

-- CreateIndex
CREATE INDEX "Author_normalizedName_idx" ON "Author"("normalizedName");

-- CreateIndex
CREATE INDEX "PaperAuthor_authorId_paperId_idx" ON "PaperAuthor"("authorId", "paperId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperAuthor_paperId_authorId_key" ON "PaperAuthor"("paperId", "authorId");
