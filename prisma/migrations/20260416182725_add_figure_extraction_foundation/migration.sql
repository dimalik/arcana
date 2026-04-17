-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT,
    "byteSize" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "assetKind" TEXT NOT NULL,
    "producerType" TEXT NOT NULL,
    "producerVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Asset_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExtractionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ExtractionRun_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExtractionSourceAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "extractionRunId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "figuresFound" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtractionSourceAttempt_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "ExtractionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FigureCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
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
    CONSTRAINT "FigureCandidate_nativeAssetId_fkey" FOREIGN KEY ("nativeAssetId") REFERENCES "Asset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Asset_paperId_idx" ON "Asset"("paperId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_paperId_contentHash_key" ON "Asset"("paperId", "contentHash");

-- CreateIndex
CREATE INDEX "ExtractionRun_paperId_createdAt_idx" ON "ExtractionRun"("paperId", "createdAt");

-- CreateIndex
CREATE INDEX "ExtractionSourceAttempt_source_status_idx" ON "ExtractionSourceAttempt"("source", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionSourceAttempt_extractionRunId_source_key" ON "ExtractionSourceAttempt"("extractionRunId", "source");

-- CreateIndex
CREATE INDEX "FigureCandidate_paperId_extractionRunId_idx" ON "FigureCandidate"("paperId", "extractionRunId");

-- CreateIndex
CREATE INDEX "FigureCandidate_paperId_figureLabelNormalized_idx" ON "FigureCandidate"("paperId", "figureLabelNormalized");

-- CreateIndex
CREATE INDEX "FigureCandidate_nativeAssetId_idx" ON "FigureCandidate"("nativeAssetId");
