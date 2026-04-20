-- CreateTable
CREATE TABLE "PaperRepresentation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "representationKind" TEXT NOT NULL,
    "encoderVersion" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "featureText" TEXT NOT NULL,
    "vectorJson" TEXT NOT NULL,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperRepresentation_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PaperRepresentation_representationKind_updatedAt_idx" ON "PaperRepresentation"("representationKind", "updatedAt");

-- CreateIndex
CREATE INDEX "PaperRepresentation_representationKind_sourceFingerprint_idx" ON "PaperRepresentation"("representationKind", "sourceFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "PaperRepresentation_paperId_representationKind_key" ON "PaperRepresentation"("paperId", "representationKind");
