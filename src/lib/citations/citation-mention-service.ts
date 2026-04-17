import { prisma } from "../prisma";
import { matchCitationToReference } from "../references/match-citation";

export interface CitationMentionInput {
  citationText: string;
  excerpt: string;
  referenceIndex?: number | null;
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

interface LegacyReferenceContextRecord {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  referenceIndex: number | null;
}

export async function createCitationMentions(
  paperId: string,
  mentions: CitationMentionInput[],
  extractorVersion: string | null,
  provenance = "llm_extraction",
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
  const referenceIdByIndex = new Map<number, string>();
  for (const referenceEntry of referenceEntries) {
    if (referenceEntry.referenceIndex != null) {
      referenceIdByIndex.set(referenceEntry.referenceIndex, referenceEntry.id);
    }
  }

  for (const mention of mentions) {
    const matchedRefId =
      (mention.referenceIndex != null
        ? referenceIdByIndex.get(mention.referenceIndex) ?? null
        : null) ??
      matchCitationToReference(mention.citationText, referenceEntries);
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
        provenance,
        extractorVersion,
      },
    });
    created++;
  }

  return { created, unmatched };
}

export async function applyLegacyCitationContexts(
  paperId: string,
  mentions: CitationMentionInput[],
): Promise<number> {
  const references = await prisma.reference.findMany({
    where: { paperId },
    select: {
      id: true,
      title: true,
      authors: true,
      year: true,
      referenceIndex: true,
    },
  });

  if (references.length === 0) return 0;

  const contextsByRef = buildLegacyCitationContexts(mentions, references);
  let updated = 0;

  for (const [refId, ctxList] of Array.from(contextsByRef.entries())) {
    await prisma.reference.update({
      where: { id: refId },
      data: { citationContext: ctxList.join("; ") },
    });
    updated += 1;
  }

  return updated;
}

function buildLegacyCitationContexts(
  mentions: CitationMentionInput[],
  references: LegacyReferenceContextRecord[],
): Map<string, string[]> {
  const contextsByRef = new Map<string, string[]>();
  const referenceIdByIndex = new Map<number, string>();

  for (const reference of references) {
    if (reference.referenceIndex != null) {
      referenceIdByIndex.set(reference.referenceIndex, reference.id);
    }
  }

  for (const mention of mentions) {
    if (!mention.citationText || !mention.excerpt) continue;

    const refId =
      (mention.referenceIndex != null
        ? referenceIdByIndex.get(mention.referenceIndex) ?? null
        : null) ??
      matchCitationToReference(mention.citationText, references);

    if (!refId) continue;

    const existing = contextsByRef.get(refId) || [];
    if (!existing.includes(mention.excerpt)) {
      existing.push(mention.excerpt);
    }
    contextsByRef.set(refId, existing);
  }

  return contextsByRef;
}
