/**
 * Backfill script: creates PaperEntity rows for identifier-bearing Papers and DiscoveryProposals.
 *
 * Run: npx tsx src/lib/canonical/backfill-entities.ts
 */
import { prisma } from "../prisma";
import { collectIdentifiers, resolveOrCreateEntity } from "./entity-service";

async function backfillPapers() {
  const papers = await prisma.paper.findMany({
    where: { entityId: null },
    select: {
      id: true,
      userId: true,
      title: true,
      authors: true,
      year: true,
      venue: true,
      abstract: true,
      doi: true,
      arxivId: true,
    },
  });

  let updated = 0;
  let skippedNoIds = 0;
  let skippedDuplicate = 0;

  for (const paper of papers) {
    const identifiers = collectIdentifiers(paper, "import");
    if (identifiers.length === 0) {
      skippedNoIds++;
      continue;
    }

    const result = await resolveOrCreateEntity({
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      abstract: paper.abstract,
      identifiers,
      source: "import",
    });

    if (paper.userId) {
      const duplicate = await prisma.paper.findFirst({
        where: {
          userId: paper.userId,
          entityId: result.entityId,
          NOT: { id: paper.id },
        },
        select: { id: true },
      });
      if (duplicate) {
        skippedDuplicate++;
        continue;
      }
    }

    await prisma.paper.update({
      where: { id: paper.id },
      data: { entityId: result.entityId },
    });
    updated++;
  }

  return { updated, skippedNoIds, skippedDuplicate };
}

async function backfillDiscoveryProposals() {
  const proposals = await prisma.discoveryProposal.findMany({
    where: { entityId: null },
    select: {
      id: true,
      title: true,
      authors: true,
      year: true,
      venue: true,
      doi: true,
      arxivId: true,
      semanticScholarId: true,
    },
  });

  let updated = 0;
  let skippedNoIds = 0;

  for (const proposal of proposals) {
    const identifiers = collectIdentifiers(proposal, "discovery");
    if (identifiers.length === 0) {
      skippedNoIds++;
      continue;
    }

    const result = await resolveOrCreateEntity({
      title: proposal.title,
      authors: proposal.authors,
      year: proposal.year,
      venue: proposal.venue,
      identifiers,
      source: "discovery",
    });

    await prisma.discoveryProposal.update({
      where: { id: proposal.id },
      data: { entityId: result.entityId },
    });
    updated++;
  }

  return { updated, skippedNoIds };
}

async function main() {
  const papers = await backfillPapers();
  const proposals = await backfillDiscoveryProposals();

  console.log(JSON.stringify({ papers, proposals }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
