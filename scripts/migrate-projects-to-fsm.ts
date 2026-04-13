import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient();

const PHASE_TO_STATE: Record<string, string> = {
  literature: "DISCOVERY",
  hypothesis: "HYPOTHESIS",
  experiment: "EXECUTION",  // DESIGN is new; existing projects in experiment have already passed design
  analysis: "ANALYSIS",
  reflection: "DECISION",
};

const FSM_STATES = ["DISCOVERY", "HYPOTHESIS", "DESIGN", "EXECUTION", "ANALYSIS", "DECISION", "COMPLETE"];

async function migrate() {
  const projects = await prisma.researchProject.findMany({
    select: { id: true, currentPhase: true, status: true },
  });

  console.log(`Found ${projects.length} projects`);
  let migrated = 0;

  for (const project of projects) {
    const oldPhase = project.currentPhase;

    // Skip if already migrated (value is already an FSM state)
    if (FSM_STATES.includes(oldPhase)) {
      console.log(`  ${project.id.slice(0, 8)}: already ${oldPhase} — skipped`);
      continue;
    }

    const newState = PHASE_TO_STATE[oldPhase];
    if (!newState) {
      console.log(`  ${project.id.slice(0, 8)}: unknown phase "${oldPhase}" — skipped`);
      continue;
    }

    await prisma.researchProject.update({
      where: { id: project.id },
      data: { currentPhase: newState },
    });

    console.log(`  ${project.id.slice(0, 8)}: ${oldPhase} -> ${newState}`);
    migrated++;
  }

  console.log(`\nMigrated ${migrated} projects`);
}

migrate()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
