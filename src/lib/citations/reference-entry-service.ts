import { prisma } from "../prisma";
import { normalizeIdentifier } from "../canonical/normalize";

export interface CreateReferenceEntryInput {
  paperId: string;
  title: string;
  rawCitation: string;
  authors?: string | null;
  year?: number | null;
  venue?: string | null;
  doi?: string | null;
  arxivId?: string | null;
  externalUrl?: string | null;
  semanticScholarId?: string | null;
  referenceIndex?: number | null;
  provenance?: string;
  extractorVersion?: string | null;
  legacyReferenceId?: string | null;
}

export async function createReferenceEntry(input: CreateReferenceEntryInput) {
  return prisma.referenceEntry.create({
    data: {
      paperId: input.paperId,
      title: input.title,
      rawCitation: input.rawCitation,
      authors: input.authors,
      year: input.year,
      venue: input.venue,
      doi: input.doi,
      arxivId: input.arxivId,
      externalUrl: input.externalUrl,
      semanticScholarId: input.semanticScholarId,
      referenceIndex: input.referenceIndex,
      provenance: input.provenance ?? "llm_extraction",
      extractorVersion: input.extractorVersion,
      legacyReferenceId: input.legacyReferenceId,
    },
  });
}

export async function resolveReferenceEntity(
  referenceEntryId: string,
  ids: { doi: string | null; arxivId: string | null; title: string }
): Promise<void> {
  if (ids.doi) {
    const normalized = normalizeIdentifier("doi", ids.doi);
    const match = await prisma.paperIdentifier.findUnique({
      where: { type_value: { type: "doi", value: normalized } },
    });
    if (match) {
      await prisma.referenceEntry.update({
        where: { id: referenceEntryId },
        data: {
          resolvedEntityId: match.entityId,
          resolveConfidence: 1.0,
          resolveSource: "doi_match",
        },
      });
      return;
    }
  }

  if (ids.arxivId) {
    const normalized = normalizeIdentifier("arxiv", ids.arxivId);
    const match = await prisma.paperIdentifier.findUnique({
      where: { type_value: { type: "arxiv", value: normalized } },
    });
    if (match) {
      await prisma.referenceEntry.update({
        where: { id: referenceEntryId },
        data: {
          resolvedEntityId: match.entityId,
          resolveConfidence: 1.0,
          resolveSource: "arxiv_match",
        },
      });
    }
  }
}
