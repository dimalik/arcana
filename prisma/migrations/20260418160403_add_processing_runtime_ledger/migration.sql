-- CreateTable
CREATE TABLE "ProcessingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "metadata" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT,
    "reconciledAt" DATETIME,
    CONSTRAINT "ProcessingRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessingStepRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "processingRunId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "metadata" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "ProcessingStepRun_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "ProcessingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProcessingStepRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProcessingRun_paperId_status_idx" ON "ProcessingRun"("paperId", "status");

-- CreateIndex
CREATE INDEX "ProcessingRun_startedAt_idx" ON "ProcessingRun"("startedAt");

-- CreateIndex
CREATE INDEX "ProcessingStepRun_processingRunId_status_idx" ON "ProcessingStepRun"("processingRunId", "status");

-- CreateIndex
CREATE INDEX "ProcessingStepRun_processingRunId_step_idx" ON "ProcessingStepRun"("processingRunId", "step");

-- CreateIndex
CREATE INDEX "ProcessingStepRun_paperId_status_idx" ON "ProcessingStepRun"("paperId", "status");
