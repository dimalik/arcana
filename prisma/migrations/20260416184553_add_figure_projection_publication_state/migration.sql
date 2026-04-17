-- CreateTable
CREATE TABLE "ProjectionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "identityResolutionId" TEXT NOT NULL,
    "projectionVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME,
    CONSTRAINT "ProjectionRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectionRun_identityResolutionId_fkey" FOREIGN KEY ("identityResolutionId") REFERENCES "IdentityResolution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectionFigure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectionRunId" TEXT NOT NULL,
    "figureIdentityId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "sourceMethod" TEXT NOT NULL,
    "imageSourceMethod" TEXT,
    "pageSourceMethod" TEXT,
    "contentCandidateId" TEXT NOT NULL,
    "basePreviewCandidateId" TEXT,
    "pageAnchorCandidateId" TEXT,
    "figureLabel" TEXT,
    "captionText" TEXT,
    "captionSource" TEXT,
    "structuredContent" TEXT,
    "structuredContentType" TEXT,
    "sourceUrl" TEXT,
    "confidence" TEXT,
    "imagePath" TEXT,
    "assetHash" TEXT,
    "pdfPage" INTEGER,
    "bbox" TEXT,
    "type" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "gapReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectionFigure_projectionRunId_fkey" FOREIGN KEY ("projectionRunId") REFERENCES "ProjectionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectionFigure_figureIdentityId_fkey" FOREIGN KEY ("figureIdentityId") REFERENCES "FigureIdentity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperPublicationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "activeProjectionRunId" TEXT,
    "activeIdentityResolutionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperPublicationState_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperPublicationState_activeProjectionRunId_fkey" FOREIGN KEY ("activeProjectionRunId") REFERENCES "ProjectionRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PaperPublicationState_activeIdentityResolutionId_fkey" FOREIGN KEY ("activeIdentityResolutionId") REFERENCES "IdentityResolution" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProjectionRun_paperId_createdAt_idx" ON "ProjectionRun"("paperId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectionRun_identityResolutionId_idx" ON "ProjectionRun"("identityResolutionId");

-- CreateIndex
CREATE INDEX "ProjectionFigure_projectionRunId_sortOrder_idx" ON "ProjectionFigure"("projectionRunId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectionFigure_projectionRunId_figureIdentityId_key" ON "ProjectionFigure"("projectionRunId", "figureIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperPublicationState_paperId_key" ON "PaperPublicationState"("paperId");

-- CreateIndex
CREATE INDEX "PaperPublicationState_activeProjectionRunId_idx" ON "PaperPublicationState"("activeProjectionRunId");

-- CreateIndex
CREATE INDEX "PaperPublicationState_activeIdentityResolutionId_idx" ON "PaperPublicationState"("activeIdentityResolutionId");
