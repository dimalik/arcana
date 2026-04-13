-- CreateTable
CREATE TABLE "TransitionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "guards" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransitionRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable: Add failureClass to RemoteJob
ALTER TABLE "RemoteJob" ADD COLUMN "failureClass" TEXT;

-- CreateIndex
CREATE INDEX "TransitionRecord_projectId_idx" ON "TransitionRecord"("projectId");

-- CreateIndex
CREATE INDEX "TransitionRecord_projectId_domain_createdAt_idx" ON "TransitionRecord"("projectId", "domain", "createdAt");

-- CreateIndex
CREATE INDEX "TransitionRecord_entityId_idx" ON "TransitionRecord"("entityId");
