import { prisma } from "../prisma";
import { matchCitationToReference } from "../references/match-citation";

export interface CitationMentionInput {
  citationText: string;
  excerpt: string;
  sectionLabel?: string | null;
  page?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  rhetoricalRole?: string | null;
}

export interface CreateCitationMentionsResult {
  created: number;
  unmatched: number;
}

export async function createCitationMentions(
  paperId: string,
  mentions: CitationMentionInput[],
  extractorVersion: string | null
): Promise<CreateCitationMentionsResult> {
  const referenceEntries = await prisma.referenceEntry.findMany({
    where: { paperId },
    select: {
      id: true,
      title: true,
      authors: true,
      year: true,
      referenceIndex: true,
    },
  });

  let created = 0;
  let unmatched = 0;

  for (const mention of mentions) {
    const matchedRefId = matchCitationToReference(mention.citationText, referenceEntries);
    if (!matchedRefId) {
      unmatched++;
      continue;
    }

    await prisma.citationMention.create({
      data: {
        paperId,
        referenceEntryId: matchedRefId,
        sectionLabel: mention.sectionLabel,
        page: mention.page,
        charStart: mention.charStart,
        charEnd: mention.charEnd,
        excerpt: mention.excerpt,
        citationText: mention.citationText,
        rhetoricalRole: mention.rhetoricalRole,
        provenance: "llm_extraction",
        extractorVersion,
      },
    });
    created++;
  }

  return { created, unmatched };
}
