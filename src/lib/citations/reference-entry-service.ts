import { prisma } from "../prisma";
import { normalizeIdentifier } from "../canonical/normalize";
import { resolveOrCreateEntity } from "../canonical/entity-service";
import { resolveReferenceOnline } from "../references/resolve";
import type { ResolutionMethod } from "../references/types";
import type { S2Result, SearchSource } from "../import/semantic-scholar";

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

export interface ReferenceEntityResolution {
  resolvedEntityId: string | null;
  resolveConfidence: number | null;
  resolveSource: ResolutionMethod | null;
  matchedFieldCount: number;
  matchedIdentifiers: Array<{ type: string; value: string }>;
  evidence: string[];
  semanticScholarId: string | null;
  externalUrl: string | null;
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
  ids: {
    doi: string | null;
    arxivId: string | null;
    title: string;
    authors?: string[] | string | null;
    year?: number | null;
    venue?: string | null;
    rawCitation?: string | null;
  }
): Promise<ReferenceEntityResolution> {
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
          resolveSource: "doi_exact",
        },
      });
      return {
        resolvedEntityId: match.entityId,
        resolveConfidence: 1.0,
        resolveSource: "doi_exact",
        matchedFieldCount: 1,
        matchedIdentifiers: [{ type: "doi", value: normalized }],
        evidence: ["doi_exact"],
        semanticScholarId: null,
        externalUrl: null,
      };
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
          resolveSource: "arxiv_exact",
        },
      });
      return {
        resolvedEntityId: match.entityId,
        resolveConfidence: 1.0,
        resolveSource: "arxiv_exact",
        matchedFieldCount: 1,
        matchedIdentifiers: [{ type: "arxiv", value: normalized }],
        evidence: ["arxiv_exact"],
        semanticScholarId: null,
        externalUrl: null,
      };
    }
  }

  try {
    const onlineResolution = await resolveReferenceOnline(ids);
    if (onlineResolution) {
      const identifiers = buildIdentifierInputs(onlineResolution.candidate);
      if (identifiers.length === 0) {
        return {
          resolvedEntityId: null,
          resolveConfidence: null,
          resolveSource: null,
          matchedFieldCount: 0,
          matchedIdentifiers: [],
          evidence: [],
          semanticScholarId: null,
          externalUrl: null,
        };
      }

      const entity = await resolveOrCreateEntity({
        title: onlineResolution.candidate.title,
        authors:
          onlineResolution.candidate.authors.length > 0
            ? JSON.stringify(onlineResolution.candidate.authors)
            : null,
        year: onlineResolution.candidate.year,
        venue: onlineResolution.candidate.venue,
        abstract: onlineResolution.candidate.abstract,
        identifiers,
        source: mapEntitySource(onlineResolution.candidate.source),
      });

      await prisma.referenceEntry.update({
        where: { id: referenceEntryId },
        data: {
          resolvedEntityId: entity.entityId,
          resolveConfidence: onlineResolution.resolutionConfidence,
          resolveSource: onlineResolution.resolutionMethod,
          semanticScholarId: onlineResolution.candidate.semanticScholarId,
          externalUrl: onlineResolution.candidate.externalUrl,
        },
      });

      return {
        resolvedEntityId: entity.entityId,
        resolveConfidence: onlineResolution.resolutionConfidence,
        resolveSource: onlineResolution.resolutionMethod,
        matchedFieldCount: onlineResolution.matchedFieldCount,
        matchedIdentifiers: onlineResolution.matchedIdentifiers,
        evidence: onlineResolution.evidence,
        semanticScholarId: onlineResolution.candidate.semanticScholarId,
        externalUrl: onlineResolution.candidate.externalUrl,
      };
    }
  } catch (error) {
    console.warn("[references] online resolution failed", {
      referenceEntryId,
      title: ids.title,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    resolvedEntityId: null,
    resolveConfidence: null,
    resolveSource: null,
    matchedFieldCount: 0,
    matchedIdentifiers: [],
    evidence: [],
    semanticScholarId: null,
    externalUrl: null,
  };
}

function buildIdentifierInputs(
  candidate: Omit<S2Result, "source"> & { source?: SearchSource | "arxiv" },
) {
  const identifiers: Array<{
    type: "doi" | "arxiv" | "semantic_scholar" | "openalex" | "openreview";
    value: string;
    source: string;
    confidence: number;
  }> = [];
  const source = mapEntitySource(candidate.source);

  if (candidate.doi) {
    identifiers.push({
      type: "doi",
      value: candidate.doi,
      source,
      confidence: 1.0,
    });
  }

  if (candidate.arxivId) {
    identifiers.push({
      type: "arxiv",
      value: candidate.arxivId,
      source,
      confidence: 1.0,
    });
  }

  if (candidate.openReviewId) {
    identifiers.push({
      type: "openreview",
      value: candidate.openReviewId,
      source,
      confidence: 0.95,
    });
  }

  if (candidate.source === "openalex" && candidate.semanticScholarId) {
    identifiers.push({
      type: "openalex",
      value: candidate.semanticScholarId,
      source,
      confidence: 0.95,
    });
  }

  if (candidate.source === "s2" && candidate.semanticScholarId) {
    identifiers.push({
      type: "semantic_scholar",
      value: candidate.semanticScholarId.replace(/^s2:/, ""),
      source,
      confidence: 0.9,
    });
  }

  return identifiers;
}

function mapEntitySource(source: "openalex" | "crossref" | "s2" | "arxiv" | undefined) {
  if (source === "s2") return "semantic_scholar";
  if (source === "arxiv") return "import";
  return source ?? "enrichment";
}
