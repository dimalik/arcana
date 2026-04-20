-- CreateTable
CREATE TABLE "PaperClaimRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceTextHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "PaperClaimRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "claimType" TEXT,
    "rhetoricalRole" TEXT NOT NULL,
    "facet" TEXT NOT NULL,
    "polarity" TEXT NOT NULL,
    "stance" TEXT,
    "evaluationContext" TEXT,
    "text" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0,
    "sectionLabel" TEXT,
    "sectionPath" TEXT NOT NULL,
    "sourceExcerpt" TEXT NOT NULL,
    "excerptHash" TEXT NOT NULL,
    "sourceSpan" TEXT,
    "citationAnchors" TEXT,
    "evidenceType" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperClaim_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperClaim_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaperClaimRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConversationArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationArtifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationArtifact_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PaperClaimRun_paperId_status_idx" ON "PaperClaimRun"("paperId", "status");

-- CreateIndex
CREATE INDEX "PaperClaimRun_paperId_createdAt_idx" ON "PaperClaimRun"("paperId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaperClaimRun_paperId_extractorVersion_sourceTextHash_key" ON "PaperClaimRun"("paperId", "extractorVersion", "sourceTextHash");

-- CreateIndex
CREATE INDEX "PaperClaim_paperId_runId_idx" ON "PaperClaim"("paperId", "runId");

-- CreateIndex
CREATE INDEX "PaperClaim_runId_orderIndex_idx" ON "PaperClaim"("runId", "orderIndex");

-- CreateIndex
CREATE INDEX "PaperClaim_paperId_rhetoricalRole_idx" ON "PaperClaim"("paperId", "rhetoricalRole");

-- CreateIndex
CREATE INDEX "PaperClaim_paperId_facet_idx" ON "PaperClaim"("paperId", "facet");

-- CreateIndex
CREATE INDEX "ConversationArtifact_conversationId_createdAt_idx" ON "ConversationArtifact"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationArtifact_messageId_idx" ON "ConversationArtifact"("messageId");
