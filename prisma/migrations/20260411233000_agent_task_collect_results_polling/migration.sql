PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_AgentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "input" TEXT,
    "output" TEXT,
    "error" TEXT,
    "tokenUsage" INTEGER,
    "lastCollectedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_AgentTask" (
    "id",
    "projectId",
    "role",
    "goal",
    "status",
    "input",
    "output",
    "error",
    "tokenUsage",
    "createdAt",
    "completedAt",
    "updatedAt"
)
SELECT
    "id",
    "projectId",
    "role",
    "goal",
    "status",
    "input",
    "output",
    "error",
    "tokenUsage",
    "createdAt",
    "completedAt",
    COALESCE("completedAt", "createdAt", CURRENT_TIMESTAMP)
FROM "AgentTask";

DROP TABLE "AgentTask";
ALTER TABLE "new_AgentTask" RENAME TO "AgentTask";

CREATE INDEX "AgentTask_projectId_idx" ON "AgentTask"("projectId");
CREATE INDEX "AgentTask_status_idx" ON "AgentTask"("status");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
