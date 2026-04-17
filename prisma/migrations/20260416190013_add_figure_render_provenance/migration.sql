/*
  Warnings:

  - You are about to drop the column `selectedCandidateId` on the `PreviewSelectionFigure` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "RenderRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "projectionRunId" TEXT NOT NULL,
    "rendererVersion" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "browserVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "RenderRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RenderRun_projectionRunId_fkey" FOREIGN KEY ("projectionRunId") REFERENCES "ProjectionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RenderedPreview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "renderRunId" TEXT NOT NULL,
    "projectionFigureId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "renderMode" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RenderedPreview_renderRunId_fkey" FOREIGN KEY ("renderRunId") REFERENCES "RenderRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RenderedPreview_projectionFigureId_fkey" FOREIGN KEY ("projectionFigureId") REFERENCES "ProjectionFigure" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RenderedPreview_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PreviewSelectionFigure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "previewSelectionRunId" TEXT NOT NULL,
    "projectionFigureId" TEXT NOT NULL,
    "selectedPreviewSource" TEXT NOT NULL,
    "selectedPreviewSourceMethod" TEXT,
    "selectedAssetId" TEXT,
    "selectedRenderedPreviewId" TEXT,
    "selectedNativeCandidateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreviewSelectionFigure_previewSelectionRunId_fkey" FOREIGN KEY ("previewSelectionRunId") REFERENCES "PreviewSelectionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionFigure_projectionFigureId_fkey" FOREIGN KEY ("projectionFigureId") REFERENCES "ProjectionFigure" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionFigure_selectedAssetId_fkey" FOREIGN KEY ("selectedAssetId") REFERENCES "Asset" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionFigure_selectedRenderedPreviewId_fkey" FOREIGN KEY ("selectedRenderedPreviewId") REFERENCES "RenderedPreview" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PreviewSelectionFigure_selectedNativeCandidateId_fkey" FOREIGN KEY ("selectedNativeCandidateId") REFERENCES "FigureCandidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PreviewSelectionFigure" ("createdAt", "id", "previewSelectionRunId", "projectionFigureId", "selectedAssetId", "selectedPreviewSource", "selectedPreviewSourceMethod") SELECT "createdAt", "id", "previewSelectionRunId", "projectionFigureId", "selectedAssetId", "selectedPreviewSource", "selectedPreviewSourceMethod" FROM "PreviewSelectionFigure";
DROP TABLE "PreviewSelectionFigure";
ALTER TABLE "new_PreviewSelectionFigure" RENAME TO "PreviewSelectionFigure";
CREATE INDEX "PreviewSelectionFigure_projectionFigureId_idx" ON "PreviewSelectionFigure"("projectionFigureId");
CREATE INDEX "PreviewSelectionFigure_selectedAssetId_idx" ON "PreviewSelectionFigure"("selectedAssetId");
CREATE INDEX "PreviewSelectionFigure_selectedRenderedPreviewId_idx" ON "PreviewSelectionFigure"("selectedRenderedPreviewId");
CREATE INDEX "PreviewSelectionFigure_selectedNativeCandidateId_idx" ON "PreviewSelectionFigure"("selectedNativeCandidateId");
CREATE UNIQUE INDEX "PreviewSelectionFigure_previewSelectionRunId_projectionFigureId_key" ON "PreviewSelectionFigure"("previewSelectionRunId", "projectionFigureId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "RenderRun_paperId_createdAt_idx" ON "RenderRun"("paperId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderRun_projectionRunId_idx" ON "RenderRun"("projectionRunId");

-- CreateIndex
CREATE INDEX "RenderedPreview_projectionFigureId_idx" ON "RenderedPreview"("projectionFigureId");

-- CreateIndex
CREATE INDEX "RenderedPreview_assetId_idx" ON "RenderedPreview"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderedPreview_renderRunId_projectionFigureId_key" ON "RenderedPreview"("renderRunId", "projectionFigureId");
