import { prisma } from "../prisma";
import {
  buildNormalizedCitationContext,
  normalizeCitationContext,
} from "./citation-context-normalization";
import {
  detectPollutedMetadataFields,
  sanitizeReferenceMetadataForDisplay,
} from "./reference-quality";

type ReferenceQualityAuditDb = Pick<typeof prisma, "referenceEntry" | "reference">;

export interface ReferenceMetadataAuditRow {
  paperId: string;
  referenceEntryId: string;
  legacyReferenceId: string | null;
  title: string;
  authors: string | null;
  venue: string | null;
  rawCitation: string;
  searchQueryTitle: string;
  pollutedFields: Array<{ field: "title" | "authors" | "venue"; beforeValue: string | null }>;
  legacyPollutedFields: Array<{ field: "title" | "authors" | "venue"; beforeValue: string | null }>;
  parityDriftFields: Array<"title" | "authors" | "venue">;
}

export interface CitationContextAuditRow {
  paperId: string;
  referenceEntryId: string;
  legacyReferenceId: string | null;
  scope: "legacy_reference_context" | "mention_projection";
  mentionId: string | null;
  beforeValue: string | null;
  normalizedValue: string | null;
}

export interface ReferenceQualityAuditReport {
  generatedAt: string;
  totals: {
    referenceEntryCount: number;
    legacyReferenceCount: number;
    pollutedReferenceEntryCount: number;
    pollutedLegacyReferenceCount: number;
    parityDriftCount: number;
    pollutedLegacyCitationContextCount: number;
    pollutedMentionProjectionCount: number;
  };
  metadataRows: ReferenceMetadataAuditRow[];
  citationContextRows: CitationContextAuditRow[];
}

export async function collectReferenceQualityAudit(
  db: ReferenceQualityAuditDb = prisma,
): Promise<ReferenceQualityAuditReport> {
  const [referenceEntries, legacyReferences] = await Promise.all([
    db.referenceEntry.findMany({
      select: {
        id: true,
        paperId: true,
        legacyReferenceId: true,
        title: true,
        authors: true,
        venue: true,
        rawCitation: true,
        citationMentions: {
          select: {
            id: true,
            excerpt: true,
            citationText: true,
            createdAt: true,
          },
        },
      },
      orderBy: { id: "asc" },
    }),
    db.reference.findMany({
      select: {
        id: true,
        paperId: true,
        title: true,
        authors: true,
        venue: true,
        citationContext: true,
      },
      orderBy: { id: "asc" },
    }),
  ]);

  const legacyById = new Map(legacyReferences.map((reference) => [reference.id, reference]));
  const metadataRows: ReferenceMetadataAuditRow[] = [];
  const citationContextRows: CitationContextAuditRow[] = [];

  let pollutedLegacyReferenceCount = 0;
  let parityDriftCount = 0;
  let pollutedLegacyCitationContextCount = 0;
  let pollutedMentionProjectionCount = 0;

  for (const entry of referenceEntries) {
    const pollutedFields = detectPollutedMetadataFields(entry);
    const legacyReference = entry.legacyReferenceId
      ? legacyById.get(entry.legacyReferenceId) ?? null
      : null;
    const legacyPollutedFields = legacyReference
      ? detectPollutedMetadataFields({
          title: legacyReference.title,
          authors: legacyReference.authors,
          venue: legacyReference.venue,
        })
      : [];
    if (legacyPollutedFields.length > 0) {
      pollutedLegacyReferenceCount += 1;
    }

    const parityDriftFields: Array<"title" | "authors" | "venue"> = [];
    if (legacyReference) {
      if ((legacyReference.title ?? "") !== (entry.title ?? "")) parityDriftFields.push("title");
      if ((legacyReference.authors ?? "") !== (entry.authors ?? "")) parityDriftFields.push("authors");
      if ((legacyReference.venue ?? "") !== (entry.venue ?? "")) parityDriftFields.push("venue");
      if (parityDriftFields.length > 0) parityDriftCount += 1;
    }

    if (pollutedFields.length > 0 || legacyPollutedFields.length > 0 || parityDriftFields.length > 0) {
      const sanitized = sanitizeReferenceMetadataForDisplay(entry);
      metadataRows.push({
        paperId: entry.paperId,
        referenceEntryId: entry.id,
        legacyReferenceId: entry.legacyReferenceId,
        title: entry.title,
        authors: entry.authors,
        venue: entry.venue,
        rawCitation: entry.rawCitation,
        searchQueryTitle: sanitized.title,
        pollutedFields,
        legacyPollutedFields,
        parityDriftFields,
      });
    }

    const sortedMentions = [...entry.citationMentions].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    const normalizedLegacyContext = buildNormalizedCitationContext(sortedMentions);

    if (
      legacyReference
      && normalizedLegacyContext
      && legacyReference.citationContext !== normalizedLegacyContext
    ) {
      citationContextRows.push({
        paperId: entry.paperId,
        referenceEntryId: entry.id,
        legacyReferenceId: entry.legacyReferenceId,
        scope: "legacy_reference_context",
        mentionId: null,
        beforeValue: legacyReference.citationContext,
        normalizedValue: normalizedLegacyContext,
      });
      pollutedLegacyCitationContextCount += 1;
    }

    for (const mention of sortedMentions) {
      const normalizedValue = normalizeCitationContext(
        mention.excerpt,
        mention.citationText,
      );
      if (normalizedValue !== mention.excerpt) {
        citationContextRows.push({
          paperId: entry.paperId,
          referenceEntryId: entry.id,
          legacyReferenceId: entry.legacyReferenceId,
          scope: "mention_projection",
          mentionId: mention.id,
          beforeValue: mention.excerpt,
          normalizedValue,
        });
        pollutedMentionProjectionCount += 1;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      referenceEntryCount: referenceEntries.length,
      legacyReferenceCount: legacyReferences.length,
      pollutedReferenceEntryCount: metadataRows.filter(
        (row) => row.pollutedFields.length > 0,
      ).length,
      pollutedLegacyReferenceCount,
      parityDriftCount,
      pollutedLegacyCitationContextCount,
      pollutedMentionProjectionCount,
    },
    metadataRows,
    citationContextRows,
  };
}
