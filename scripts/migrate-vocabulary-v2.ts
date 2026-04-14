import { PrismaClient } from "../src/generated/prisma/client";
import path from "path";

const dbPath = path.join(process.cwd(), "prisma", "dev.db");
const prisma = new PrismaClient({
  datasourceUrl: `file:${dbPath}`,
});

const HYPOTHESIS_STATUS_MAP: Record<string, string> = {
  PROPOSED: "PROPOSED",
  TESTING: "ACTIVE",
  SUPPORTED: "SUPPORTED",
  REFUTED: "RETIRED",
  REVISED: "REVISED",
};

const PROJECT_STATUS_MAP: Record<string, string> = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  COMPLETED: "ARCHIVED",
  FAILED: "FAILED",
};

const APPROACH_STATUS_MAP: Record<string, string> = {
  active: "ACTIVE",
  abandoned: "ABANDONED",
  completed: "COMPLETED",
  ACTIVE: "ACTIVE",
  ABANDONED: "ABANDONED",
  COMPLETED: "COMPLETED",
};

async function migrate() {
  console.log("=== FSM v2 Vocabulary Migration ===\n");

  // 1. Hypothesis statuses
  const hypotheses = await prisma.researchHypothesis.findMany({
    select: { id: true, status: true },
  });
  let hypMigrated = 0;
  for (const h of hypotheses) {
    const newStatus = HYPOTHESIS_STATUS_MAP[h.status];
    if (newStatus && newStatus !== h.status) {
      await prisma.researchHypothesis.update({
        where: { id: h.id },
        data: { status: newStatus },
      });
      hypMigrated++;
    }
  }
  console.log(`Hypotheses: ${hypMigrated} migrated of ${hypotheses.length}`);

  // 2. Project statuses (overlay)
  const projects = await prisma.researchProject.findMany({
    select: { id: true, status: true },
  });
  let projMigrated = 0;
  for (const p of projects) {
    const newStatus = PROJECT_STATUS_MAP[p.status];
    if (newStatus && newStatus !== p.status) {
      await prisma.researchProject.update({
        where: { id: p.id },
        data: { status: newStatus },
      });
      projMigrated++;
    }
  }
  console.log(`Projects: ${projMigrated} migrated of ${projects.length}`);

  // 3. Approach statuses
  const approaches = await prisma.approachBranch.findMany({
    select: { id: true, status: true },
  });
  let appMigrated = 0;
  for (const a of approaches) {
    const newStatus = APPROACH_STATUS_MAP[a.status || "active"];
    if (newStatus && newStatus !== a.status) {
      await prisma.approachBranch.update({
        where: { id: a.id },
        data: { status: newStatus },
      });
      appMigrated++;
    }
  }
  console.log(`Approaches: ${appMigrated} migrated of ${approaches.length}`);

  console.log("\n=== Done ===");
}

migrate()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
