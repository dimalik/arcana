-- CreateTable
CREATE TABLE "PublishedFigureHandle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "retiredAt" DATETIME,
    CONSTRAINT "PublishedFigureHandle_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaperFigure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "publishedFigureHandleId" TEXT,
    "figureLabel" TEXT,
    "captionText" TEXT,
    "captionSource" TEXT NOT NULL DEFAULT 'none',
    "description" TEXT,
    "sourceMethod" TEXT NOT NULL DEFAULT 'pdf_embedded',
    "sourceUrl" TEXT,
    "sourceVersion" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "imagePath" TEXT,
    "assetHash" TEXT,
    "pdfPage" INTEGER,
    "sourcePage" INTEGER,
    "figureIndex" INTEGER NOT NULL DEFAULT 0,
    "bbox" TEXT,
    "type" TEXT NOT NULL DEFAULT 'figure',
    "parentFigureId" TEXT,
    "isPrimaryExtraction" BOOLEAN NOT NULL DEFAULT true,
    "width" INTEGER,
    "height" INTEGER,
    "gapReason" TEXT,
    "imageSourceMethod" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperFigure_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperFigure_publishedFigureHandleId_fkey" FOREIGN KEY ("publishedFigureHandleId") REFERENCES "PublishedFigureHandle" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PaperFigure_parentFigureId_fkey" FOREIGN KEY ("parentFigureId") REFERENCES "PaperFigure" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PaperFigure" ("assetHash", "bbox", "captionSource", "captionText", "confidence", "createdAt", "description", "figureIndex", "figureLabel", "gapReason", "height", "id", "imagePath", "imageSourceMethod", "isPrimaryExtraction", "paperId", "parentFigureId", "pdfPage", "sourceMethod", "sourcePage", "sourceUrl", "sourceVersion", "type", "width") SELECT "assetHash", "bbox", "captionSource", "captionText", "confidence", "createdAt", "description", "figureIndex", "figureLabel", "gapReason", "height", "id", "imagePath", "imageSourceMethod", "isPrimaryExtraction", "paperId", "parentFigureId", "pdfPage", "sourceMethod", "sourcePage", "sourceUrl", "sourceVersion", "type", "width" FROM "PaperFigure";
DROP TABLE "PaperFigure";
ALTER TABLE "new_PaperFigure" RENAME TO "PaperFigure";
CREATE INDEX "PaperFigure_paperId_idx" ON "PaperFigure"("paperId");
CREATE INDEX "PaperFigure_assetHash_idx" ON "PaperFigure"("assetHash");
CREATE UNIQUE INDEX "PaperFigure_paperId_sourceMethod_assetHash_key" ON "PaperFigure"("paperId", "sourceMethod", "assetHash");
CREATE UNIQUE INDEX "PaperFigure_paperId_sourceMethod_figureLabel_key" ON "PaperFigure"("paperId", "sourceMethod", "figureLabel");
CREATE UNIQUE INDEX "PaperFigure_publishedFigureHandleId_key" ON "PaperFigure"("publishedFigureHandleId");
CREATE TABLE "new_ProjectionFigure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectionRunId" TEXT NOT NULL,
    "figureIdentityId" TEXT NOT NULL,
    "publishedFigureHandleId" TEXT,
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
    "predecessorProjectionFigureId" TEXT,
    "handleAssignmentDecision" TEXT,
    "handleAssignmentVersion" TEXT,
    "handleAssignmentEvidenceType" TEXT,
    "handleAssignmentEvidenceIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectionFigure_projectionRunId_fkey" FOREIGN KEY ("projectionRunId") REFERENCES "ProjectionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectionFigure_figureIdentityId_fkey" FOREIGN KEY ("figureIdentityId") REFERENCES "FigureIdentity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectionFigure_publishedFigureHandleId_fkey" FOREIGN KEY ("publishedFigureHandleId") REFERENCES "PublishedFigureHandle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ProjectionFigure" ("assetHash", "basePreviewCandidateId", "bbox", "captionSource", "captionText", "confidence", "contentCandidateId", "createdAt", "figureIdentityId", "figureLabel", "gapReason", "height", "id", "imagePath", "imageSourceMethod", "pageAnchorCandidateId", "pageSourceMethod", "pdfPage", "projectionRunId", "sortOrder", "sourceMethod", "sourceUrl", "structuredContent", "structuredContentType", "type", "width") SELECT "assetHash", "basePreviewCandidateId", "bbox", "captionSource", "captionText", "confidence", "contentCandidateId", "createdAt", "figureIdentityId", "figureLabel", "gapReason", "height", "id", "imagePath", "imageSourceMethod", "pageAnchorCandidateId", "pageSourceMethod", "pdfPage", "projectionRunId", "sortOrder", "sourceMethod", "sourceUrl", "structuredContent", "structuredContentType", "type", "width" FROM "ProjectionFigure";
DROP TABLE "ProjectionFigure";
ALTER TABLE "new_ProjectionFigure" RENAME TO "ProjectionFigure";
CREATE INDEX "ProjectionFigure_projectionRunId_sortOrder_idx" ON "ProjectionFigure"("projectionRunId", "sortOrder");
CREATE INDEX "ProjectionFigure_publishedFigureHandleId_idx" ON "ProjectionFigure"("publishedFigureHandleId");
CREATE UNIQUE INDEX "ProjectionFigure_projectionRunId_figureIdentityId_key" ON "ProjectionFigure"("projectionRunId", "figureIdentityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PublishedFigureHandle_publicKey_key" ON "PublishedFigureHandle"("publicKey");

-- CreateIndex
CREATE INDEX "PublishedFigureHandle_paperId_status_idx" ON "PublishedFigureHandle"("paperId", "status");
