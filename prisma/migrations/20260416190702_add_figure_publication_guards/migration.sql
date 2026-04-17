-- CreateTable
CREATE TABLE "PaperWorkLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperWorkLease_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PaperWorkLease_paperId_key" ON "PaperWorkLease"("paperId");

-- CreateIndex
CREATE INDEX "PaperWorkLease_expiresAt_idx" ON "PaperWorkLease"("expiresAt");
