-- CreateTable
CREATE TABLE "LegacyPublicationBootstrapRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "LegacyPublicationBootstrapRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperMigrationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "latestBootstrapRunId" TEXT,
    "migrationState" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperMigrationState_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperMigrationState_latestBootstrapRunId_fkey" FOREIGN KEY ("latestBootstrapRunId") REFERENCES "LegacyPublicationBootstrapRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FigureCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "extractionRunId" TEXT,
    "bootstrapRunId" TEXT,
    "candidateOrigin" TEXT NOT NULL DEFAULT 'extracted',
    "sourceMethod" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceLocalLocator" TEXT,
    "locatorSupport" TEXT NOT NULL DEFAULT 'unsupported',
    "sourceNamespace" TEXT,
    "sourceOrder" INTEGER NOT NULL DEFAULT 0,
    "figureLabelRaw" TEXT,
    "figureLabelNormalized" TEXT,
    "captionTextRaw" TEXT,
    "structuredContentRaw" TEXT,
    "structuredContentType" TEXT,
    "nativeAssetId" TEXT,
    "nativePreviewTrust" TEXT NOT NULL DEFAULT 'none',
    "pageAnchorCandidate" TEXT,
    "confidence" TEXT,
    "diagnostics" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FigureCandidate_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FigureCandidate_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "ExtractionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FigureCandidate_bootstrapRunId_fkey" FOREIGN KEY ("bootstrapRunId") REFERENCES "LegacyPublicationBootstrapRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FigureCandidate_nativeAssetId_fkey" FOREIGN KEY ("nativeAssetId") REFERENCES "Asset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FigureCandidate" ("candidateOrigin", "captionTextRaw", "confidence", "createdAt", "diagnostics", "extractionRunId", "figureLabelNormalized", "figureLabelRaw", "id", "locatorSupport", "nativeAssetId", "nativePreviewTrust", "pageAnchorCandidate", "paperId", "sourceLocalLocator", "sourceMethod", "sourceNamespace", "sourceOrder", "structuredContentRaw", "structuredContentType", "type") SELECT "candidateOrigin", "captionTextRaw", "confidence", "createdAt", "diagnostics", "extractionRunId", "figureLabelNormalized", "figureLabelRaw", "id", "locatorSupport", "nativeAssetId", "nativePreviewTrust", "pageAnchorCandidate", "paperId", "sourceLocalLocator", "sourceMethod", "sourceNamespace", "sourceOrder", "structuredContentRaw", "structuredContentType", "type" FROM "FigureCandidate";
DROP TABLE "FigureCandidate";
ALTER TABLE "new_FigureCandidate" RENAME TO "FigureCandidate";
CREATE INDEX "FigureCandidate_paperId_extractionRunId_idx" ON "FigureCandidate"("paperId", "extractionRunId");
CREATE INDEX "FigureCandidate_paperId_bootstrapRunId_idx" ON "FigureCandidate"("paperId", "bootstrapRunId");
CREATE INDEX "FigureCandidate_paperId_figureLabelNormalized_idx" ON "FigureCandidate"("paperId", "figureLabelNormalized");
CREATE INDEX "FigureCandidate_nativeAssetId_idx" ON "FigureCandidate"("nativeAssetId");
CREATE TABLE "new_IdentityResolution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "provenanceKind" TEXT NOT NULL DEFAULT 'extraction',
    "extractionRunId" TEXT,
    "bootstrapRunId" TEXT,
    "resolverVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" DATETIME,
    CONSTRAINT "IdentityResolution_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IdentityResolution_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "ExtractionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IdentityResolution_bootstrapRunId_fkey" FOREIGN KEY ("bootstrapRunId") REFERENCES "LegacyPublicationBootstrapRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_IdentityResolution" ("createdAt", "extractionRunId", "id", "metadata", "paperId", "promotedAt", "resolverVersion", "status") SELECT "createdAt", "extractionRunId", "id", "metadata", "paperId", "promotedAt", "resolverVersion", "status" FROM "IdentityResolution";
DROP TABLE "IdentityResolution";
ALTER TABLE "new_IdentityResolution" RENAME TO "IdentityResolution";
CREATE INDEX "IdentityResolution_paperId_createdAt_idx" ON "IdentityResolution"("paperId", "createdAt");
CREATE INDEX "IdentityResolution_extractionRunId_idx" ON "IdentityResolution"("extractionRunId");
CREATE INDEX "IdentityResolution_bootstrapRunId_idx" ON "IdentityResolution"("bootstrapRunId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LegacyPublicationBootstrapRun_paperId_createdAt_idx" ON "LegacyPublicationBootstrapRun"("paperId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaperMigrationState_paperId_key" ON "PaperMigrationState"("paperId");

-- CreateIndex
CREATE INDEX "PaperMigrationState_latestBootstrapRunId_idx" ON "PaperMigrationState"("latestBootstrapRunId");
