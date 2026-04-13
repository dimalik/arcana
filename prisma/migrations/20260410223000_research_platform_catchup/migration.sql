-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "avatarUrl" TEXT,
    "researchRole" TEXT,
    "affiliation" TEXT,
    "domains" TEXT,
    "expertiseLevel" TEXT,
    "reviewFocus" TEXT,
    "scholarUrl" TEXT,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LlmUsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LlmUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "templateId" TEXT,
    "customPrompt" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'analyze',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "events" TEXT NOT NULL DEFAULT '[]',
    "costUsd" REAL,
    "durationMs" INTEGER,
    "turns" INTEGER,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSession_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TagCluster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DiscoverySession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "depth" INTEGER NOT NULL DEFAULT 1,
    "totalFound" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscoverySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscoverySeed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    CONSTRAINT "DiscoverySeed_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiscoverySession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscoverySeed_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscoveryProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT,
    "year" INTEGER,
    "venue" TEXT,
    "doi" TEXT,
    "arxivId" TEXT,
    "externalUrl" TEXT,
    "citationCount" INTEGER,
    "openAccessPdfUrl" TEXT,
    "semanticScholarId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "importedPaperId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscoveryProposal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiscoverySession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscoveryProposal_importedPaperId_fkey" FOREIGN KEY ("importedPaperId") REFERENCES "Paper" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperEngagement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperEngagement_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperFigure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "figureIndex" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL DEFAULT 'figure',
    "caption" TEXT,
    "description" TEXT,
    "imagePath" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperFigure_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MindPalaceRoom" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366F1',
    "icon" TEXT NOT NULL DEFAULT 'brain',
    "isAutoGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "learning" TEXT NOT NULL,
    "significance" TEXT NOT NULL,
    "applications" TEXT,
    "userNotes" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "easeFactor" REAL NOT NULL DEFAULT 2.5,
    "interval" INTEGER NOT NULL DEFAULT 0,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "nextReviewAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReviewedAt" DATETIME,
    "isAutoGenerated" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "projectId" TEXT,
    "sourceClaimId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Insight_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "MindPalaceRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Insight_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Insight_sourceClaimId_fkey" FOREIGN KEY ("sourceClaimId") REFERENCES "ResearchClaim" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SynthesisSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "query" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "depth" TEXT NOT NULL DEFAULT 'balanced',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "phase" TEXT,
    "progress" REAL NOT NULL DEFAULT 0,
    "paperCount" INTEGER NOT NULL DEFAULT 0,
    "plan" TEXT,
    "guidanceMessages" TEXT,
    "guidance" TEXT,
    "output" TEXT,
    "vizData" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SynthesisPaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "digest" TEXT,
    "themes" TEXT,
    CONSTRAINT "SynthesisPaper_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SynthesisSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SynthesisPaper_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SynthesisSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sectionType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "citations" TEXT,
    CONSTRAINT "SynthesisSection_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SynthesisSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SETUP',
    "methodology" TEXT,
    "currentPhase" TEXT NOT NULL DEFAULT 'literature',
    "metricSchema" TEXT,
    "collectionId" TEXT,
    "outputFolder" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResearchProject_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchIteration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reflection" TEXT,
    "nextActions" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ResearchIteration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "iterationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "input" TEXT,
    "output" TEXT,
    "agentSessionId" TEXT,
    "discoveryId" TEXT,
    "synthesisId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ResearchStep_iterationId_fkey" FOREIGN KEY ("iterationId") REFERENCES "ResearchIteration" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchHypothesis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "rationale" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "evidence" TEXT,
    "theme" TEXT,
    "parentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchHypothesis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResearchHypothesis_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ResearchHypothesis" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RemoteHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alias" TEXT NOT NULL,
    "backend" TEXT NOT NULL DEFAULT 'ssh',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "user" TEXT NOT NULL,
    "keyPath" TEXT,
    "workDir" TEXT NOT NULL DEFAULT '~/experiments',
    "gpuType" TEXT,
    "conda" TEXT,
    "setupCmd" TEXT,
    "baseRequirements" TEXT,
    "envNotes" TEXT,
    "envVars" TEXT,
    "cleanupPolicy" TEXT NOT NULL DEFAULT 'archive',
    "maxArchives" INTEGER NOT NULL DEFAULT 20,
    "pyrightInstalled" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RemoteJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostId" TEXT NOT NULL,
    "stepId" TEXT,
    "projectId" TEXT,
    "runId" TEXT,
    "localDir" TEXT NOT NULL,
    "remoteDir" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "remotePid" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'SYNCING',
    "exitCode" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "resultsSynced" BOOLEAN NOT NULL DEFAULT false,
    "scriptHash" TEXT,
    "hypothesisId" TEXT,
    "fixAttempts" INTEGER NOT NULL DEFAULT 0,
    "errorClass" TEXT,
    "runDir" TEXT,
    "archivedAt" DATETIME,
    "diagnostics" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "RemoteJob_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "RemoteHost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RemoteJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExperimentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExperimentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "hypothesisId" TEXT,
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
    CONSTRAINT "ExperimentRun_requestedHostId_fkey" FOREIGN KEY ("requestedHostId") REFERENCES "RemoteHost" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExperimentAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "hostId" TEXT,
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
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExperimentAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExperimentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExperimentAttempt_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "RemoteHost" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExperimentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT,
    "type" TEXT NOT NULL,
    "stateFrom" TEXT,
    "stateTo" TEXT,
    "message" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExperimentEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExperimentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExperimentEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExperimentAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExecutorLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leaseKey" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "runId" TEXT,
    "attemptId" TEXT,
    "hostId" TEXT,
    "projectId" TEXT,
    "leaseVersion" INTEGER NOT NULL DEFAULT 1,
    "leaseExpiresAt" DATETIME NOT NULL,
    "leaseAcquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExecutorLease_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExperimentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExecutorLease_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExperimentAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExecutorLease_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "RemoteHost" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExecutorLease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "input" TEXT,
    "output" TEXT,
    "error" TEXT,
    "tokenUsage" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "AgentTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchLogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchLogEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApproachBranch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApproachBranch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApproachBranch_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ApproachBranch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExperimentResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "jobId" TEXT,
    "hypothesisId" TEXT,
    "branchId" TEXT,
    "baselineId" TEXT,
    "scriptName" TEXT NOT NULL,
    "parameters" TEXT,
    "metrics" TEXT,
    "rawMetrics" TEXT,
    "condition" TEXT,
    "comparison" TEXT,
    "verdict" TEXT,
    "reflection" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExperimentResult_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExperimentResult_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "ApproachBranch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "resultId" TEXT,
    "type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "caption" TEXT,
    "keyTakeaway" TEXT,
    "size" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Artifact_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ExperimentResult" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "hypothesisId" TEXT,
    "resultId" TEXT,
    "taskId" TEXT,
    "statement" TEXT NOT NULL,
    "summary" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "confidence" TEXT NOT NULL DEFAULT 'PRELIMINARY',
    "createdBy" TEXT NOT NULL DEFAULT 'agent',
    "createdFrom" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchClaim_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ResearchClaim_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "ResearchHypothesis" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ResearchClaim_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ExperimentResult" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ResearchClaim_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClaimEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "claimId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "supports" BOOLEAN NOT NULL DEFAULT true,
    "strength" TEXT NOT NULL DEFAULT 'DIRECT',
    "rationale" TEXT,
    "excerpt" TEXT,
    "locator" TEXT,
    "paperId" TEXT,
    "hypothesisId" TEXT,
    "resultId" TEXT,
    "artifactId" TEXT,
    "logEntryId" TEXT,
    "taskId" TEXT,
    "remoteJobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaimEvidence_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ResearchClaim" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvidence_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvidence_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "ResearchHypothesis" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvidence_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ExperimentResult" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvidence_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvidence_logEntryId_fkey" FOREIGN KEY ("logEntryId") REFERENCES "ResearchLogEntry" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvidence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvidence_remoteJobId_fkey" FOREIGN KEY ("remoteJobId") REFERENCES "RemoteJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResourceRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "runtime" TEXT NOT NULL,
    "needs" TEXT,
    "reason" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResourceRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentCapability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentCapability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "lesson" TEXT NOT NULL,
    "context" TEXT,
    "projectId" TEXT,
    "sourceClaimId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "confidence" REAL,
    "lastValidatedAt" DATETIME,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentMemory_sourceClaimId_fkey" FOREIGN KEY ("sourceClaimId") REFERENCES "ResearchClaim" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessingBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "anthropicBatchId" TEXT,
    "groupId" TEXT NOT NULL,
    "phase" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BUILDING',
    "modelId" TEXT NOT NULL,
    "paperIds" TEXT NOT NULL,
    "stepTypes" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "error" TEXT
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
    "citationCount" INTEGER,
    "isLiked" BOOLEAN NOT NULL DEFAULT false,
    "isResearchOnly" BOOLEAN NOT NULL DEFAULT false,
    "engagementScore" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Paper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Paper" ("abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "filePath", "fullText", "id", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "venue", "year") SELECT "abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "filePath", "fullText", "id", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "venue", "year" FROM "Paper";
DROP TABLE "Paper";
ALTER TABLE "new_Paper" RENAME TO "Paper";
CREATE TABLE "new_Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "isAutoGenerated" BOOLEAN NOT NULL DEFAULT false,
    "score" REAL NOT NULL DEFAULT 0,
    "clusterId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tag_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "TagCluster" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Tag" ("color", "createdAt", "id", "isAutoGenerated", "name") SELECT "color", "createdAt", "id", "isAutoGenerated", "name" FROM "Tag";
DROP TABLE "Tag";
ALTER TABLE "new_Tag" RENAME TO "Tag";
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");
CREATE INDEX "Tag_clusterId_idx" ON "Tag"("clusterId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_token_key" ON "UserSession"("token");

-- CreateIndex
CREATE INDEX "UserSession_token_idx" ON "UserSession"("token");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE INDEX "LlmUsageLog_userId_idx" ON "LlmUsageLog"("userId");

-- CreateIndex
CREATE INDEX "LlmUsageLog_createdAt_idx" ON "LlmUsageLog"("createdAt");

-- CreateIndex
CREATE INDEX "LlmUsageLog_operation_idx" ON "LlmUsageLog"("operation");

-- CreateIndex
CREATE INDEX "LlmUsageLog_modelId_idx" ON "LlmUsageLog"("modelId");

-- CreateIndex
CREATE INDEX "AppEvent_userId_idx" ON "AppEvent"("userId");

-- CreateIndex
CREATE INDEX "AppEvent_level_idx" ON "AppEvent"("level");

-- CreateIndex
CREATE INDEX "AppEvent_category_idx" ON "AppEvent"("category");

-- CreateIndex
CREATE INDEX "AppEvent_createdAt_idx" ON "AppEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_paperId_idx" ON "AgentSession"("paperId");

-- CreateIndex
CREATE UNIQUE INDEX "TagCluster_name_key" ON "TagCluster"("name");

-- CreateIndex
CREATE INDEX "DiscoverySession_userId_idx" ON "DiscoverySession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoverySeed_sessionId_paperId_key" ON "DiscoverySeed"("sessionId", "paperId");

-- CreateIndex
CREATE INDEX "PaperEngagement_paperId_idx" ON "PaperEngagement"("paperId");

-- CreateIndex
CREATE INDEX "PaperEngagement_paperId_event_idx" ON "PaperEngagement"("paperId", "event");

-- CreateIndex
CREATE INDEX "PaperFigure_paperId_idx" ON "PaperFigure"("paperId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperFigure_paperId_page_figureIndex_key" ON "PaperFigure"("paperId", "page", "figureIndex");

-- CreateIndex
CREATE UNIQUE INDEX "MindPalaceRoom_name_key" ON "MindPalaceRoom"("name");

-- CreateIndex
CREATE INDEX "Insight_roomId_idx" ON "Insight"("roomId");

-- CreateIndex
CREATE INDEX "Insight_paperId_idx" ON "Insight"("paperId");

-- CreateIndex
CREATE INDEX "Insight_nextReviewAt_idx" ON "Insight"("nextReviewAt");

-- CreateIndex
CREATE INDEX "Insight_source_idx" ON "Insight"("source");

-- CreateIndex
CREATE INDEX "Insight_sourceClaimId_idx" ON "Insight"("sourceClaimId");

-- CreateIndex
CREATE INDEX "SynthesisPaper_sessionId_idx" ON "SynthesisPaper"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SynthesisPaper_sessionId_paperId_key" ON "SynthesisPaper"("sessionId", "paperId");

-- CreateIndex
CREATE INDEX "SynthesisSection_sessionId_idx" ON "SynthesisSection"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchProject_collectionId_key" ON "ResearchProject"("collectionId");

-- CreateIndex
CREATE INDEX "ResearchProject_userId_idx" ON "ResearchProject"("userId");

-- CreateIndex
CREATE INDEX "ResearchIteration_projectId_idx" ON "ResearchIteration"("projectId");

-- CreateIndex
CREATE INDEX "ResearchStep_iterationId_idx" ON "ResearchStep"("iterationId");

-- CreateIndex
CREATE INDEX "ResearchHypothesis_projectId_idx" ON "ResearchHypothesis"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "RemoteHost_alias_key" ON "RemoteHost"("alias");

-- CreateIndex
CREATE INDEX "RemoteJob_hostId_idx" ON "RemoteJob"("hostId");

-- CreateIndex
CREATE INDEX "RemoteJob_stepId_idx" ON "RemoteJob"("stepId");

-- CreateIndex
CREATE INDEX "RemoteJob_runId_idx" ON "RemoteJob"("runId");

-- CreateIndex
CREATE INDEX "RemoteJob_status_idx" ON "RemoteJob"("status");

-- CreateIndex
CREATE INDEX "RemoteJob_projectId_status_idx" ON "RemoteJob"("projectId", "status");

-- CreateIndex
CREATE INDEX "ExperimentRun_state_idx" ON "ExperimentRun"("state");

-- CreateIndex
CREATE INDEX "ExperimentRun_projectId_state_idx" ON "ExperimentRun"("projectId", "state");

-- CreateIndex
CREATE INDEX "ExperimentRun_requestedHostId_state_idx" ON "ExperimentRun"("requestedHostId", "state");

-- CreateIndex
CREATE INDEX "ExperimentRun_createdAt_idx" ON "ExperimentRun"("createdAt");

-- CreateIndex
CREATE INDEX "ExperimentRun_queuedAt_idx" ON "ExperimentRun"("queuedAt");

-- CreateIndex
CREATE INDEX "ExperimentAttempt_state_idx" ON "ExperimentAttempt"("state");

-- CreateIndex
CREATE INDEX "ExperimentAttempt_runId_state_idx" ON "ExperimentAttempt"("runId", "state");

-- CreateIndex
CREATE INDEX "ExperimentAttempt_hostId_state_idx" ON "ExperimentAttempt"("hostId", "state");

-- CreateIndex
CREATE INDEX "ExperimentAttempt_createdAt_idx" ON "ExperimentAttempt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentAttempt_runId_attemptNumber_key" ON "ExperimentAttempt"("runId", "attemptNumber");

-- CreateIndex
CREATE INDEX "ExperimentEvent_runId_createdAt_idx" ON "ExperimentEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ExperimentEvent_attemptId_createdAt_idx" ON "ExperimentEvent"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "ExperimentEvent_type_createdAt_idx" ON "ExperimentEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ExperimentEvent_createdAt_idx" ON "ExperimentEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorLease_leaseKey_key" ON "ExecutorLease"("leaseKey");

-- CreateIndex
CREATE INDEX "ExecutorLease_leaseExpiresAt_idx" ON "ExecutorLease"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ExecutorLease_projectId_leaseExpiresAt_idx" ON "ExecutorLease"("projectId", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ExecutorLease_hostId_leaseExpiresAt_idx" ON "ExecutorLease"("hostId", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ExecutorLease_scope_leaseExpiresAt_idx" ON "ExecutorLease"("scope", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ExecutorLease_createdAt_idx" ON "ExecutorLease"("createdAt");

-- CreateIndex
CREATE INDEX "AgentTask_projectId_idx" ON "AgentTask"("projectId");

-- CreateIndex
CREATE INDEX "AgentTask_status_idx" ON "AgentTask"("status");

-- CreateIndex
CREATE INDEX "ResearchLogEntry_projectId_idx" ON "ResearchLogEntry"("projectId");

-- CreateIndex
CREATE INDEX "ResearchLogEntry_createdAt_idx" ON "ResearchLogEntry"("createdAt");

-- CreateIndex
CREATE INDEX "ApproachBranch_projectId_idx" ON "ApproachBranch"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentResult_jobId_key" ON "ExperimentResult"("jobId");

-- CreateIndex
CREATE INDEX "ExperimentResult_projectId_idx" ON "ExperimentResult"("projectId");

-- CreateIndex
CREATE INDEX "ExperimentResult_branchId_idx" ON "ExperimentResult"("branchId");

-- CreateIndex
CREATE INDEX "Artifact_projectId_idx" ON "Artifact"("projectId");

-- CreateIndex
CREATE INDEX "Artifact_resultId_idx" ON "Artifact"("resultId");

-- CreateIndex
CREATE INDEX "Artifact_type_idx" ON "Artifact"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_projectId_filename_key" ON "Artifact"("projectId", "filename");

-- CreateIndex
CREATE INDEX "ResearchClaim_projectId_status_idx" ON "ResearchClaim"("projectId", "status");

-- CreateIndex
CREATE INDEX "ResearchClaim_hypothesisId_idx" ON "ResearchClaim"("hypothesisId");

-- CreateIndex
CREATE INDEX "ResearchClaim_resultId_idx" ON "ResearchClaim"("resultId");

-- CreateIndex
CREATE INDEX "ResearchClaim_taskId_idx" ON "ResearchClaim"("taskId");

-- CreateIndex
CREATE INDEX "ResearchClaim_createdAt_idx" ON "ResearchClaim"("createdAt");

-- CreateIndex
CREATE INDEX "ClaimEvidence_claimId_supports_idx" ON "ClaimEvidence"("claimId", "supports");

-- CreateIndex
CREATE INDEX "ClaimEvidence_paperId_idx" ON "ClaimEvidence"("paperId");

-- CreateIndex
CREATE INDEX "ClaimEvidence_hypothesisId_idx" ON "ClaimEvidence"("hypothesisId");

-- CreateIndex
CREATE INDEX "ClaimEvidence_resultId_idx" ON "ClaimEvidence"("resultId");

-- CreateIndex
CREATE INDEX "ClaimEvidence_artifactId_idx" ON "ClaimEvidence"("artifactId");

-- CreateIndex
CREATE INDEX "ClaimEvidence_logEntryId_idx" ON "ClaimEvidence"("logEntryId");

-- CreateIndex
CREATE INDEX "ClaimEvidence_taskId_idx" ON "ClaimEvidence"("taskId");

-- CreateIndex
CREATE INDEX "ClaimEvidence_remoteJobId_idx" ON "ClaimEvidence"("remoteJobId");

-- CreateIndex
CREATE INDEX "ResourceRule_projectId_idx" ON "ResourceRule"("projectId");

-- CreateIndex
CREATE INDEX "AgentCapability_userId_idx" ON "AgentCapability"("userId");

-- CreateIndex
CREATE INDEX "AgentMemory_userId_idx" ON "AgentMemory"("userId");

-- CreateIndex
CREATE INDEX "AgentMemory_sourceClaimId_idx" ON "AgentMemory"("sourceClaimId");

-- CreateIndex
CREATE INDEX "AgentMemory_userId_status_idx" ON "AgentMemory"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingBatch_anthropicBatchId_key" ON "ProcessingBatch"("anthropicBatchId");

-- CreateIndex
CREATE INDEX "ProcessingBatch_groupId_idx" ON "ProcessingBatch"("groupId");

-- CreateIndex
CREATE INDEX "ProcessingBatch_status_idx" ON "ProcessingBatch"("status");

