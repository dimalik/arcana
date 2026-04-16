import { describe, expect, it } from "vitest";

import { prisma } from "../../prisma";
import { normalizeIdentifier } from "../../canonical/normalize";

type CountRow = {
  count: bigint | number;
};

describe("Phase 2 parity", () => {
  it("every legacy Reference has a corresponding ReferenceEntry", async () => {
    const legacyCount = await prisma.reference.count();
    const migratedCount = await prisma.referenceEntry.count({
      where: { legacyReferenceId: { not: null } },
    });

    expect(migratedCount).toBe(legacyCount);
  });

  it("legacy-backed ReferenceEntry rows preserve key migrated fields", async () => {
    const [row] = await prisma.$queryRawUnsafe<CountRow[]>(`
      SELECT COUNT(*) AS count
      FROM ReferenceEntry re
      JOIN Reference r ON r.id = re.legacyReferenceId
      WHERE
        re.paperId != r.paperId
        OR re.title != r.title
        OR COALESCE(re.authors, '') != COALESCE(r.authors, '')
        OR COALESCE(re.year, -1) != COALESCE(r.year, -1)
        OR COALESCE(re.venue, '') != COALESCE(r.venue, '')
        OR COALESCE(re.doi, '') != COALESCE(r.doi, '')
        OR COALESCE(re.arxivId, '') != COALESCE(r.arxivId, '')
        OR COALESCE(re.externalUrl, '') != COALESCE(r.externalUrl, '')
        OR COALESCE(re.semanticScholarId, '') != COALESCE(r.semanticScholarId, '')
        OR COALESCE(re.rawCitation, '') != COALESCE(r.rawCitation, '')
        OR COALESCE(re.referenceIndex, -1) != COALESCE(r.referenceIndex, -1)
    `);

    expect(Number(row?.count ?? 0)).toBe(0);
  });

  it("every legacyReferenceId bridge points to a real Reference row", async () => {
    const [row] = await prisma.$queryRawUnsafe<CountRow[]>(`
      SELECT COUNT(*) AS count
      FROM ReferenceEntry re
      LEFT JOIN Reference r ON r.id = re.legacyReferenceId
      WHERE re.legacyReferenceId IS NOT NULL AND r.id IS NULL
    `);

    expect(Number(row?.count ?? 0)).toBe(0);
  });

  it("reference entries resolve when their DOI or arXiv already maps to a canonical entity", async () => {
    const identifiers = await prisma.paperIdentifier.findMany({
      where: { type: { in: ["doi", "arxiv"] } },
      select: { type: true, value: true, entityId: true },
    });

    const entityByIdentifier = new Map<string, string>();
    for (const identifier of identifiers) {
      entityByIdentifier.set(`${identifier.type}::${identifier.value}`, identifier.entityId);
    }

    const referenceEntries = await prisma.referenceEntry.findMany({
      where: {
        legacyReferenceId: { not: null },
        OR: [{ doi: { not: null } }, { arxivId: { not: null } }],
      },
      select: {
        id: true,
        doi: true,
        arxivId: true,
        resolvedEntityId: true,
      },
    });

    const failures: string[] = [];
    for (const entry of referenceEntries) {
      let expectedEntityId: string | undefined;

      if (entry.doi) {
        expectedEntityId = entityByIdentifier.get(
          `doi::${normalizeIdentifier("doi", entry.doi)}`
        );
      }

      if (!expectedEntityId && entry.arxivId) {
        expectedEntityId = entityByIdentifier.get(
          `arxiv::${normalizeIdentifier("arxiv", entry.arxivId)}`
        );
      }

      if (expectedEntityId && entry.resolvedEntityId !== expectedEntityId) {
        failures.push(
          `${entry.id}: expected ${expectedEntityId}, got ${entry.resolvedEntityId ?? "null"}`
        );
      }
    }

    expect(failures, failures.slice(0, 10).join("\n")).toHaveLength(0);
  });
});
