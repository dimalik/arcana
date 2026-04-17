#!/usr/bin/env -S node --import tsx
/**
 * Bootstrap legacy PaperFigure rows into the snapshot-backed publication model.
 *
 * Usage:
 *   node --import tsx scripts/bootstrap-legacy-figures.ts <paper-id>
 *   node --import tsx scripts/bootstrap-legacy-figures.ts <id1> <id2> ...
 *   npm run figures:bootstrap-legacy -- <paper-id>
 */

import { prisma } from "../src/lib/prisma";
import { bootstrapLegacyPublication } from "../src/lib/figures/legacy-publication-bootstrap";

async function main() {
  const paperIds = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (paperIds.length === 0) {
    console.log("Usage: node --import tsx scripts/bootstrap-legacy-figures.ts <paper-id> [<paper-id> ...]");
    console.log("       npm run figures:bootstrap-legacy -- <paper-id>");
    process.exit(1);
  }

  let successCount = 0;

  for (let index = 0; index < paperIds.length; index += 1) {
    const paperId = paperIds[index];
    console.log(`[${index + 1}/${paperIds.length}] Bootstrapping ${paperId}`);

    try {
      const result = await bootstrapLegacyPublication(paperId);
      console.log(
        `  bootstrapRun=${result.bootstrapRunId} identityResolution=${result.identityResolutionId} projection=${result.projectionRunId} candidates=${result.candidateCount}`,
      );
      successCount += 1;
    } catch (error) {
      console.error(`  ERROR: ${(error as Error).message}`);
    }
  }

  if (paperIds.length > 1) {
    console.log(`Completed ${successCount}/${paperIds.length} bootstrap runs`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
