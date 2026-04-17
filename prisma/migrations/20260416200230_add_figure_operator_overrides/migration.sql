-- CreateTable
CREATE TABLE "FigureOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "overrideType" TEXT NOT NULL,
    "overrideStage" TEXT NOT NULL,
    "selectorType" TEXT NOT NULL,
    "selectorValue" TEXT NOT NULL,
    "payload" TEXT,
    "reason" TEXT,
    "createdBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "disabledAt" DATETIME,
    CONSTRAINT "FigureOverride_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FigureOverride_paperId_status_overrideStage_idx" ON "FigureOverride"("paperId", "status", "overrideStage");

-- CreateIndex
CREATE INDEX "FigureOverride_paperId_selectorType_selectorValue_status_idx" ON "FigureOverride"("paperId", "selectorType", "selectorValue", "status");
