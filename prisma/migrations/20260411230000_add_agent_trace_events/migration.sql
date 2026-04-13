-- CreateTable
CREATE TABLE "AgentTraceEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sessionNumber" INTEGER NOT NULL DEFAULT 1,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "stepNumber" INTEGER,
    "toolName" TEXT,
    "toolCallId" TEXT,
    "content" TEXT,
    "argsJson" TEXT,
    "resultJson" TEXT,
    "activityJson" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentTraceEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentTraceEvent_runId_sequence_key" ON "AgentTraceEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "AgentTraceEvent_projectId_createdAt_idx" ON "AgentTraceEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTraceEvent_projectId_runId_sequence_idx" ON "AgentTraceEvent"("projectId", "runId", "sequence");

-- CreateIndex
CREATE INDEX "AgentTraceEvent_projectId_eventType_createdAt_idx" ON "AgentTraceEvent"("projectId", "eventType", "createdAt");
