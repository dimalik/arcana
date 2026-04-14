/*
  Warnings:

  - You are about to drop the column `guards` on the `TransitionRecord` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "ExperimentIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "hypothesisId" TEXT NOT NULL,
    "approachId" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "scriptName" TEXT NOT NULL,
    "scriptHash" TEXT NOT NULL,
    "protocolHash" TEXT NOT NULL,
    "args" TEXT,
    "purpose" TEXT NOT NULL,
    "grounding" TEXT,
    "completionCriterion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "supersedesIntentId" TEXT,
    "createdFromTransitionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExperimentIntent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExperimentIntent_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "ResearchHypothesis" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExperimentIntent_approachId_fkey" FOREIGN KEY ("approachId") REFERENCES "ApproachBranch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExperimentIntent_supersedesIntentId_fkey" FOREIGN KEY ("supersedesIntentId") REFERENCES "ExperimentIntent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HypothesisApproachLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hypothesisId" TEXT NOT NULL,
    "approachId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "rationale" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HypothesisApproachLink_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "ResearchHypothesis" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HypothesisApproachLink_approachId_fkey" FOREIGN KEY ("approachId") REFERENCES "ApproachBranch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvariantViolation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "invariantKey" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "escalationPolicy" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "repairedByTransitionId" TEXT,
    CONSTRAINT "InvariantViolation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BlockingReason" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockingReason_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "input" TEXT,
    "output" TEXT,
    "error" TEXT,
    "tokenUsage" INTEGER,
    "lastCollectedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentTask" ("completedAt", "createdAt", "error", "goal", "id", "input", "lastCollectedAt", "output", "projectId", "role", "status", "tokenUsage", "updatedAt") SELECT "completedAt", "createdAt", "error", "goal", "id", "input", "lastCollectedAt", "output", "projectId", "role", "status", "tokenUsage", "updatedAt" FROM "AgentTask";
DROP TABLE "AgentTask";
ALTER TABLE "new_AgentTask" RENAME TO "AgentTask";
CREATE INDEX "AgentTask_projectId_idx" ON "AgentTask"("projectId");
CREATE INDEX "AgentTask_status_idx" ON "AgentTask"("status");
CREATE TABLE "new_ExperimentAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "hostId" TEXT,
    "hostAlias" TEXT,
    "remoteJobId" TEXT,
    "isAutoFixResubmit" BOOLEAN NOT NULL DEFAULT false,
    "localDir" TEXT,
    "remoteDir" TEXT,
    "runDir" TEXT,
    "helperVersion" TEXT,
    "remotePid" INTEGER,
    "remotePgid" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'STARTING',
    "exitCode" INTEGER,
    "diagnostics" TEXT,
    "stdoutTail" TEXT,
    "stderrTail" TEXT,
    "errorClass" TEXT,
    "errorReason" TEXT,
    "failureClass" TEXT,
    "failureReason" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" DATETIME,
    "lastHeartbeatAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExperimentAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExperimentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExperimentAttempt_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "RemoteHost" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExperimentAttempt_remoteJobId_fkey" FOREIGN KEY ("remoteJobId") REFERENCES "RemoteJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ExperimentAttempt" ("attemptNumber", "completedAt", "createdAt", "diagnostics", "errorClass", "errorReason", "exitCode", "heartbeatAt", "helperVersion", "hostId", "id", "localDir", "remoteDir", "remotePgid", "remotePid", "runDir", "runId", "startedAt", "state", "stderrTail", "stdoutTail", "updatedAt") SELECT "attemptNumber", "completedAt", "createdAt", "diagnostics", "errorClass", "errorReason", "exitCode", "heartbeatAt", "helperVersion", "hostId", "id", "localDir", "remoteDir", "remotePgid", "remotePid", "runDir", "runId", "startedAt", "state", "stderrTail", "stdoutTail", "updatedAt" FROM "ExperimentAttempt";
DROP TABLE "ExperimentAttempt";
ALTER TABLE "new_ExperimentAttempt" RENAME TO "ExperimentAttempt";
CREATE UNIQUE INDEX "ExperimentAttempt_remoteJobId_key" ON "ExperimentAttempt"("remoteJobId");
CREATE INDEX "ExperimentAttempt_runId_idx" ON "ExperimentAttempt"("runId");
CREATE INDEX "ExperimentAttempt_state_idx" ON "ExperimentAttempt"("state");
CREATE INDEX "ExperimentAttempt_runId_state_idx" ON "ExperimentAttempt"("runId", "state");
CREATE INDEX "ExperimentAttempt_hostId_state_idx" ON "ExperimentAttempt"("hostId", "state");
CREATE INDEX "ExperimentAttempt_createdAt_idx" ON "ExperimentAttempt"("createdAt");
CREATE UNIQUE INDEX "ExperimentAttempt_runId_attemptNumber_key" ON "ExperimentAttempt"("runId", "attemptNumber");
CREATE TABLE "new_ExperimentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "hypothesisId" TEXT,
    "intentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'research',
    "purpose" TEXT,
    "overlay" TEXT,
    "seed" INTEGER,
    "condition" TEXT,
    "runKey" TEXT,
    "experimentPurpose" TEXT,
    "grounding" TEXT,
    "claimEligibility" TEXT,
    "promotionPolicy" TEXT,
    "evidenceClass" TEXT,
    "requestedHostId" TEXT,
    "command" TEXT NOT NULL,
    "scriptName" TEXT,
    "scriptHash" TEXT,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "maxAutoFixAttempts" INTEGER NOT NULL DEFAULT 2,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorClass" TEXT,
    "lastErrorReason" TEXT,
    "metadata" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "cancelRequestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExperimentRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExperimentRun_requestedHostId_fkey" FOREIGN KEY ("requestedHostId") REFERENCES "RemoteHost" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExperimentRun_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ExperimentIntent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ExperimentRun" ("attemptCount", "cancelRequestedAt", "claimEligibility", "command", "completedAt", "createdAt", "evidenceClass", "experimentPurpose", "grounding", "hypothesisId", "id", "lastErrorClass", "lastErrorReason", "maxAttempts", "maxAutoFixAttempts", "metadata", "priority", "projectId", "promotionPolicy", "queuedAt", "requestedHostId", "scriptHash", "scriptName", "startedAt", "state", "updatedAt") SELECT "attemptCount", "cancelRequestedAt", "claimEligibility", "command", "completedAt", "createdAt", "evidenceClass", "experimentPurpose", "grounding", "hypothesisId", "id", "lastErrorClass", "lastErrorReason", "maxAttempts", "maxAutoFixAttempts", "metadata", "priority", "projectId", "promotionPolicy", "queuedAt", "requestedHostId", "scriptHash", "scriptName", "startedAt", "state", "updatedAt" FROM "ExperimentRun";
DROP TABLE "ExperimentRun";
ALTER TABLE "new_ExperimentRun" RENAME TO "ExperimentRun";
CREATE INDEX "ExperimentRun_state_idx" ON "ExperimentRun"("state");
CREATE INDEX "ExperimentRun_projectId_state_idx" ON "ExperimentRun"("projectId", "state");
CREATE INDEX "ExperimentRun_requestedHostId_state_idx" ON "ExperimentRun"("requestedHostId", "state");
CREATE INDEX "ExperimentRun_intentId_idx" ON "ExperimentRun"("intentId");
CREATE INDEX "ExperimentRun_createdAt_idx" ON "ExperimentRun"("createdAt");
CREATE INDEX "ExperimentRun_queuedAt_idx" ON "ExperimentRun"("queuedAt");
CREATE UNIQUE INDEX "ExperimentRun_intentId_runKey_key" ON "ExperimentRun"("intentId", "runKey");
CREATE TABLE "new_ResearchProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'RESEARCH',
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SETUP',
    "methodology" TEXT,
    "currentPhase" TEXT NOT NULL DEFAULT 'DISCOVERY',
    "metricSchema" TEXT,
    "collectionId" TEXT,
    "outputFolder" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResearchProject_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ResearchProject" ("brief", "collectionId", "createdAt", "currentPhase", "id", "kind", "methodology", "metricSchema", "outputFolder", "status", "title", "updatedAt", "userId") SELECT "brief", "collectionId", "createdAt", "currentPhase", "id", "kind", "methodology", "metricSchema", "outputFolder", "status", "title", "updatedAt", "userId" FROM "ResearchProject";
DROP TABLE "ResearchProject";
ALTER TABLE "new_ResearchProject" RENAME TO "ResearchProject";
CREATE UNIQUE INDEX "ResearchProject_collectionId_key" ON "ResearchProject"("collectionId");
CREATE INDEX "ResearchProject_userId_idx" ON "ResearchProject"("userId");
CREATE INDEX "ResearchProject_userId_kind_updatedAt_idx" ON "ResearchProject"("userId", "kind", "updatedAt");
CREATE TABLE "new_TransitionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "causedByEvent" TEXT,
    "causedByEntityType" TEXT,
    "causedByEntityId" TEXT,
    "agentSessionId" TEXT,
    "traceRunId" TEXT,
    "basis" TEXT NOT NULL,
    "guardsEvaluated" TEXT,
    "entityVersion" TEXT,
    "guardContextHash" TEXT,
    "guardContextSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransitionRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TransitionRecord" ("basis", "createdAt", "domain", "entityId", "fromState", "id", "projectId", "toState", "trigger") SELECT "basis", "createdAt", "domain", "entityId", "fromState", "id", "projectId", "toState", "trigger" FROM "TransitionRecord";
DROP TABLE "TransitionRecord";
ALTER TABLE "new_TransitionRecord" RENAME TO "TransitionRecord";
CREATE INDEX "TransitionRecord_projectId_idx" ON "TransitionRecord"("projectId");
CREATE INDEX "TransitionRecord_projectId_domain_createdAt_idx" ON "TransitionRecord"("projectId", "domain", "createdAt");
CREATE INDEX "TransitionRecord_entityId_idx" ON "TransitionRecord"("entityId");
CREATE INDEX "TransitionRecord_causedByEntityId_idx" ON "TransitionRecord"("causedByEntityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ExperimentIntent_projectId_idx" ON "ExperimentIntent"("projectId");

-- CreateIndex
CREATE INDEX "ExperimentIntent_projectId_status_idx" ON "ExperimentIntent"("projectId", "status");

-- CreateIndex
CREATE INDEX "ExperimentIntent_hypothesisId_idx" ON "ExperimentIntent"("hypothesisId");

-- CreateIndex
CREATE INDEX "HypothesisApproachLink_hypothesisId_idx" ON "HypothesisApproachLink"("hypothesisId");

-- CreateIndex
CREATE INDEX "HypothesisApproachLink_approachId_idx" ON "HypothesisApproachLink"("approachId");

-- CreateIndex
CREATE UNIQUE INDEX "HypothesisApproachLink_hypothesisId_approachId_key" ON "HypothesisApproachLink"("hypothesisId", "approachId");

-- CreateIndex
CREATE INDEX "InvariantViolation_projectId_status_idx" ON "InvariantViolation"("projectId", "status");

-- CreateIndex
CREATE INDEX "InvariantViolation_invariantKey_entityId_idx" ON "InvariantViolation"("invariantKey", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "InvariantViolation_projectId_invariantKey_entityId_status_key" ON "InvariantViolation"("projectId", "invariantKey", "entityId", "status");

-- CreateIndex
CREATE INDEX "BlockingReason_projectId_domain_entityId_idx" ON "BlockingReason"("projectId", "domain", "entityId");

-- CreateIndex
CREATE INDEX "BlockingReason_entityId_resolvedAt_idx" ON "BlockingReason"("entityId", "resolvedAt");
