/**
 * Backfill: migrate legacy Reference rows to ReferenceEntry rows.
 *
 * Run: npx tsx src/lib/citations/backfill-references.ts
 */
import { prisma } from "../prisma";
import { createReferenceEntry, resolveReferenceEntity } from "./reference-entry-service";

async function main() {
  const legacyReferences = await prisma.reference.findMany({
    select: {
      id: true,
      paperId: true,
      title: true,
      authors: true,
      year: true,
      venue: true,
      doi: true,
      arxivId: true,
      externalUrl: true,
      semanticScholarId: true,
      rawCitation: true,
      referenceIndex: true,
    },
  });

  const existingEntriesByLegacyId = new Map(
    (
      await prisma.referenceEntry.findMany({
        where: { legacyReferenceId: { not: null } },
        select: { id: true, legacyReferenceId: true },
      })
    )
      .filter(
        (reference): reference is { id: string; legacyReferenceId: string } =>
          Boolean(reference.legacyReferenceId)
      )
      .map((reference) => [reference.legacyReferenceId, reference.id])
  );

  let created = 0;
  let rechecked = 0;
  let resolved = 0;
  let errors = 0;

  for (const reference of legacyReferences) {
    try {
      let entryId = existingEntriesByLegacyId.get(reference.id);

      if (!entryId) {
        const entry = await createReferenceEntry({
          paperId: reference.paperId,
          title: reference.title,
          rawCitation: reference.rawCitation,
          authors: reference.authors,
          year: reference.year,
          venue: reference.venue,
          doi: reference.doi,
          arxivId: reference.arxivId,
          externalUrl: reference.externalUrl,
          semanticScholarId: reference.semanticScholarId,
          referenceIndex: reference.referenceIndex,
          provenance: "llm_extraction",
          extractorVersion: "backfill_v1",
          legacyReferenceId: reference.id,
        });
        entryId = entry.id;
        existingEntriesByLegacyId.set(reference.id, entry.id);
        created++;
      } else {
        rechecked++;
      }

      await resolveReferenceEntity(entryId, {
        doi: reference.doi,
        arxivId: reference.arxivId,
        title: reference.title,
        authors: reference.authors,
        year: reference.year,
        venue: reference.venue,
        rawCitation: reference.rawCitation,
      });

      const updated = await prisma.referenceEntry.findUnique({
        where: { id: entryId },
        select: { resolvedEntityId: true },
      });
      if (updated?.resolvedEntityId) {
        resolved++;
      }
    } catch (error) {
      errors++;
      console.error(`[backfill] Failed to migrate reference ${reference.id}:`, error);
    }
  }

  console.log(JSON.stringify({ created, rechecked, resolved, errors }, null, 2));
}

main()
  .catch((error) => {
    console.error("[backfill] Fatal:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
