-- CreateTable
CREATE TABLE "PaperEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "authors" TEXT,
    "year" INTEGER,
    "venue" TEXT,
    "abstract" TEXT,
    "titleSource" TEXT,
    "authorsSource" TEXT,
    "yearSource" TEXT,
    "venueSource" TEXT,
    "mergedIntoEntityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperEntity_mergedIntoEntityId_fkey" FOREIGN KEY ("mergedIntoEntityId") REFERENCES "PaperEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperIdentifier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "raw" TEXT,
    "source" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperIdentifier_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "PaperEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperEntityCandidateLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityAId" TEXT NOT NULL,
    "entityBId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "PaperEntityCandidateLink_entityAId_fkey" FOREIGN KEY ("entityAId") REFERENCES "PaperEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperEntityCandidateLink_entityBId_fkey" FOREIGN KEY ("entityBId") REFERENCES "PaperEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReferenceEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "referenceIndex" INTEGER,
    "rawCitation" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT,
    "year" INTEGER,
    "venue" TEXT,
    "doi" TEXT,
    "arxivId" TEXT,
    "externalUrl" TEXT,
    "semanticScholarId" TEXT,
    "resolvedEntityId" TEXT,
    "resolveConfidence" REAL,
    "resolveSource" TEXT,
    "provenance" TEXT NOT NULL DEFAULT 'llm_extraction',
    "extractorVersion" TEXT,
    "legacyReferenceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferenceEntry_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReferenceEntry_resolvedEntityId_fkey" FOREIGN KEY ("resolvedEntityId") REFERENCES "PaperEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CitationMention" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "referenceEntryId" TEXT NOT NULL,
    "sectionLabel" TEXT,
    "page" INTEGER,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "excerpt" TEXT NOT NULL,
    "citationText" TEXT NOT NULL,
    "rhetoricalRole" TEXT,
    "provenance" TEXT NOT NULL DEFAULT 'llm_extraction',
    "extractorVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CitationMention_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CitationMention_referenceEntryId_fkey" FOREIGN KEY ("referenceEntryId") REFERENCES "ReferenceEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RelationAssertion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceEntityId" TEXT NOT NULL,
    "targetEntityId" TEXT NOT NULL,
    "sourcePaperId" TEXT,
    "relationType" TEXT NOT NULL,
    "description" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.0,
    "provenance" TEXT NOT NULL,
    "extractorVersion" TEXT,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelationAssertion_sourceEntityId_fkey" FOREIGN KEY ("sourceEntityId") REFERENCES "PaperEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RelationAssertion_targetEntityId_fkey" FOREIGN KEY ("targetEntityId") REFERENCES "PaperEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RelationAssertion_sourcePaperId_fkey" FOREIGN KEY ("sourcePaperId") REFERENCES "Paper" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RelationEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assertionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "excerpt" TEXT,
    "citationMentionId" TEXT,
    "referenceEntryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelationEvidence_assertionId_fkey" FOREIGN KEY ("assertionId") REFERENCES "RelationAssertion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RelationEvidence_citationMentionId_fkey" FOREIGN KEY ("citationMentionId") REFERENCES "CitationMention" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RelationEvidence_referenceEntryId_fkey" FOREIGN KEY ("referenceEntryId") REFERENCES "ReferenceEntry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DiscoveryProposal" (
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
    "entityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscoveryProposal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiscoverySession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DiscoveryProposal_importedPaperId_fkey" FOREIGN KEY ("importedPaperId") REFERENCES "Paper" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DiscoveryProposal_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "PaperEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DiscoveryProposal" ("arxivId", "authors", "citationCount", "createdAt", "doi", "externalUrl", "id", "importedPaperId", "openAccessPdfUrl", "reason", "semanticScholarId", "sessionId", "status", "title", "venue", "year") SELECT "arxivId", "authors", "citationCount", "createdAt", "doi", "externalUrl", "id", "importedPaperId", "openAccessPdfUrl", "reason", "semanticScholarId", "sessionId", "status", "title", "venue", "year" FROM "DiscoveryProposal";
DROP TABLE "DiscoveryProposal";
ALTER TABLE "new_DiscoveryProposal" RENAME TO "DiscoveryProposal";
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
    "entityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Paper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Paper_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "PaperEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Paper" ("abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "engagementScore", "filePath", "fullText", "id", "isLiked", "isResearchOnly", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "userId", "venue", "year") SELECT "abstract", "arxivId", "authors", "categories", "citationCount", "createdAt", "doi", "engagementScore", "filePath", "fullText", "id", "isLiked", "isResearchOnly", "keyFindings", "processingStartedAt", "processingStatus", "processingStep", "sourceType", "sourceUrl", "summary", "title", "updatedAt", "userId", "venue", "year" FROM "Paper";
DROP TABLE "Paper";
ALTER TABLE "new_Paper" RENAME TO "Paper";
CREATE UNIQUE INDEX "Paper_userId_entityId_key" ON "Paper"("userId", "entityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PaperEntity_mergedIntoEntityId_idx" ON "PaperEntity"("mergedIntoEntityId");

-- CreateIndex
CREATE INDEX "PaperIdentifier_entityId_idx" ON "PaperIdentifier"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperIdentifier_type_value_key" ON "PaperIdentifier"("type", "value");

-- CreateIndex
CREATE INDEX "PaperEntityCandidateLink_status_idx" ON "PaperEntityCandidateLink"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PaperEntityCandidateLink_entityAId_entityBId_key" ON "PaperEntityCandidateLink"("entityAId", "entityBId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceEntry_legacyReferenceId_key" ON "ReferenceEntry"("legacyReferenceId");

-- CreateIndex
CREATE INDEX "ReferenceEntry_paperId_idx" ON "ReferenceEntry"("paperId");

-- CreateIndex
CREATE INDEX "ReferenceEntry_resolvedEntityId_idx" ON "ReferenceEntry"("resolvedEntityId");

-- CreateIndex
CREATE INDEX "CitationMention_paperId_idx" ON "CitationMention"("paperId");

-- CreateIndex
CREATE INDEX "CitationMention_referenceEntryId_idx" ON "CitationMention"("referenceEntryId");

-- CreateIndex
CREATE INDEX "RelationAssertion_sourceEntityId_targetEntityId_idx" ON "RelationAssertion"("sourceEntityId", "targetEntityId");

-- CreateIndex
CREATE INDEX "RelationAssertion_sourcePaperId_idx" ON "RelationAssertion"("sourcePaperId");

-- CreateIndex
CREATE INDEX "RelationAssertion_relationType_idx" ON "RelationAssertion"("relationType");

-- CreateIndex
CREATE UNIQUE INDEX "RelationAssertion_sourcePaperId_targetEntityId_relationType_provenance_key" ON "RelationAssertion"("sourcePaperId", "targetEntityId", "relationType", "provenance");

-- CreateIndex
CREATE INDEX "RelationEvidence_assertionId_idx" ON "RelationEvidence"("assertionId");

-- CreateIndex
CREATE INDEX "RelationEvidence_citationMentionId_idx" ON "RelationEvidence"("citationMentionId");
