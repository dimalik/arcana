-- CreateTable
CREATE TABLE "IdentityResolution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "resolverVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" DATETIME,
    CONSTRAINT "IdentityResolution_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IdentityResolution_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "ExtractionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FigureIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identityResolutionId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "identityNamespace" TEXT,
    "canonicalLabelNormalized" TEXT,
    "identityKey" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FigureIdentity_identityResolutionId_fkey" FOREIGN KEY ("identityResolutionId") REFERENCES "IdentityResolution" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FigureIdentity_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FigureIdentityMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "figureIdentityId" TEXT NOT NULL,
    "figureCandidateId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FigureIdentityMember_figureIdentityId_fkey" FOREIGN KEY ("figureIdentityId") REFERENCES "FigureIdentity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FigureIdentityMember_figureCandidateId_fkey" FOREIGN KEY ("figureCandidateId") REFERENCES "FigureCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "IdentityResolution_paperId_createdAt_idx" ON "IdentityResolution"("paperId", "createdAt");

-- CreateIndex
CREATE INDEX "IdentityResolution_extractionRunId_idx" ON "IdentityResolution"("extractionRunId");

-- CreateIndex
CREATE INDEX "FigureIdentity_paperId_canonicalLabelNormalized_idx" ON "FigureIdentity"("paperId", "canonicalLabelNormalized");

-- CreateIndex
CREATE INDEX "FigureIdentity_identityResolutionId_idx" ON "FigureIdentity"("identityResolutionId");

-- CreateIndex
CREATE UNIQUE INDEX "FigureIdentity_identityResolutionId_identityKey_key" ON "FigureIdentity"("identityResolutionId", "identityKey");

-- CreateIndex
CREATE INDEX "FigureIdentityMember_figureCandidateId_idx" ON "FigureIdentityMember"("figureCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "FigureIdentityMember_figureIdentityId_figureCandidateId_key" ON "FigureIdentityMember"("figureIdentityId", "figureCandidateId");
