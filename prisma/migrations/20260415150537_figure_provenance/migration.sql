/*
  Warnings:

  - You are about to drop the column `caption` on the `PaperFigure` table. All the data in the column will be lost.
  - You are about to drop the column `page` on the `PaperFigure` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaperFigure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperFigure_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperFigure_parentFigureId_fkey" FOREIGN KEY ("parentFigureId") REFERENCES "PaperFigure" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PaperFigure" ("createdAt", "description", "figureIndex", "height", "id", "imagePath", "paperId", "type", "width") SELECT "createdAt", "description", "figureIndex", "height", "id", "imagePath", "paperId", "type", "width" FROM "PaperFigure";
DROP TABLE "PaperFigure";
ALTER TABLE "new_PaperFigure" RENAME TO "PaperFigure";
CREATE INDEX "PaperFigure_paperId_idx" ON "PaperFigure"("paperId");
CREATE INDEX "PaperFigure_assetHash_idx" ON "PaperFigure"("assetHash");
CREATE UNIQUE INDEX "PaperFigure_paperId_sourceMethod_assetHash_key" ON "PaperFigure"("paperId", "sourceMethod", "assetHash");
CREATE UNIQUE INDEX "PaperFigure_paperId_sourceMethod_figureLabel_key" ON "PaperFigure"("paperId", "sourceMethod", "figureLabel");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
