-- CreateTable
CREATE TABLE "PreviewSelectionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "projectionRunId" TEXT NOT NULL,
    "selectionKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "comparisonStatus" TEXT,
    "comparisonSummary" TEXT,
    "publicationMode" TEXT,
    "metadata" TEXT,
    "supersedesPreviewSelectionRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" DATETIME,
    CONSTRAINT "PreviewSelectionRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionRun_projectionRunId_fkey" FOREIGN KEY ("projectionRunId") REFERENCES "ProjectionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionRun_supersedesPreviewSelectionRunId_fkey" FOREIGN KEY ("supersedesPreviewSelectionRunId") REFERENCES "PreviewSelectionRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PreviewSelectionFigure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "previewSelectionRunId" TEXT NOT NULL,
    "projectionFigureId" TEXT NOT NULL,
    "selectedPreviewSource" TEXT NOT NULL,
    "selectedPreviewSourceMethod" TEXT,
    "selectedAssetId" TEXT,
    "selectedCandidateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreviewSelectionFigure_previewSelectionRunId_fkey" FOREIGN KEY ("previewSelectionRunId") REFERENCES "PreviewSelectionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionFigure_projectionFigureId_fkey" FOREIGN KEY ("projectionFigureId") REFERENCES "ProjectionFigure" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionFigure_selectedAssetId_fkey" FOREIGN KEY ("selectedAssetId") REFERENCES "Asset" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionFigure_selectedCandidateId_fkey" FOREIGN KEY ("selectedCandidateId") REFERENCES "FigureCandidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaperPublicationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "activeProjectionRunId" TEXT,
    "activeIdentityResolutionId" TEXT,
    "activePreviewSelectionRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperPublicationState_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperPublicationState_activeProjectionRunId_fkey" FOREIGN KEY ("activeProjectionRunId") REFERENCES "ProjectionRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PaperPublicationState_activeIdentityResolutionId_fkey" FOREIGN KEY ("activeIdentityResolutionId") REFERENCES "IdentityResolution" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PaperPublicationState_activePreviewSelectionRunId_fkey" FOREIGN KEY ("activePreviewSelectionRunId") REFERENCES "PreviewSelectionRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PaperPublicationState" ("activeIdentityResolutionId", "activeProjectionRunId", "createdAt", "id", "paperId", "updatedAt") SELECT "activeIdentityResolutionId", "activeProjectionRunId", "createdAt", "id", "paperId", "updatedAt" FROM "PaperPublicationState";
DROP TABLE "PaperPublicationState";
ALTER TABLE "new_PaperPublicationState" RENAME TO "PaperPublicationState";
CREATE UNIQUE INDEX "PaperPublicationState_paperId_key" ON "PaperPublicationState"("paperId");
CREATE INDEX "PaperPublicationState_activeProjectionRunId_idx" ON "PaperPublicationState"("activeProjectionRunId");
CREATE INDEX "PaperPublicationState_activeIdentityResolutionId_idx" ON "PaperPublicationState"("activeIdentityResolutionId");
CREATE INDEX "PaperPublicationState_activePreviewSelectionRunId_idx" ON "PaperPublicationState"("activePreviewSelectionRunId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PreviewSelectionRun_paperId_createdAt_idx" ON "PreviewSelectionRun"("paperId", "createdAt");

-- CreateIndex
CREATE INDEX "PreviewSelectionRun_projectionRunId_idx" ON "PreviewSelectionRun"("projectionRunId");

-- CreateIndex
CREATE INDEX "PreviewSelectionRun_supersedesPreviewSelectionRunId_idx" ON "PreviewSelectionRun"("supersedesPreviewSelectionRunId");

-- CreateIndex
CREATE INDEX "PreviewSelectionFigure_projectionFigureId_idx" ON "PreviewSelectionFigure"("projectionFigureId");

-- CreateIndex
CREATE INDEX "PreviewSelectionFigure_selectedAssetId_idx" ON "PreviewSelectionFigure"("selectedAssetId");

-- CreateIndex
CREATE INDEX "PreviewSelectionFigure_selectedCandidateId_idx" ON "PreviewSelectionFigure"("selectedCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "PreviewSelectionFigure_previewSelectionRunId_projectionFigureId_key" ON "PreviewSelectionFigure"("previewSelectionRunId", "projectionFigureId");
