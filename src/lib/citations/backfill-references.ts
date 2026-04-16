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

  const existingLegacyIds = new Set(
    (await prisma.referenceEntry.findMany({
      where: { legacyReferenceId: { not: null } },
      select: { legacyReferenceId: true },
    }))
      .map((reference) => reference.legacyReferenceId)
      .filter((id): id is string => Boolean(id))
  );

  const toMigrate = legacyReferences.filter((reference) => !existingLegacyIds.has(reference.id));

  let created = 0;
  let resolved = 0;
  let errors = 0;

  for (const reference of toMigrate) {
    try {
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

      created++;

      await resolveReferenceEntity(entry.id, {
        doi: reference.doi,
        arxivId: reference.arxivId,
        title: reference.title,
      });

      const updated = await prisma.referenceEntry.findUnique({
        where: { id: entry.id },
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

  console.log(JSON.stringify({ created, resolved, errors }, null, 2));
}

main()
  .catch((error) => {
    console.error("[backfill] Fatal:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
