import { prisma } from "../prisma";
import { normalizeIdentifier } from "../canonical/normalize";
import { resolveOrCreateEntity } from "../canonical/entity-service";
import { resolveReferenceOnline } from "../references/resolve";
import { syncPaperReferenceState } from "../references/reference-state";
import {
  candidateAuthorsPassTrustCheck,
  cleanReferenceText,
  looksLikePollutedAuthors,
  looksLikePollutedTitle,
  looksLikePollutedVenue,
  referenceMetadataNeedsRepair,
} from "../references/reference-quality";
import type {
  ReferenceMetadataFieldAction,
  ReferenceMetadataFieldActions,
} from "../references/reference-quality-manifest";
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

export interface DeleteReferenceEntryResult {
  referenceEntryId: string;
  legacyReferenceId: string | null;
}

export interface ReferenceEntryProjectionResult {
  referenceEntryId: string;
  legacyReferenceId: string | null;
}

export interface ReferenceEntryMutationTarget {
  id: string;
  paperId: string;
  legacyReferenceId: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  rawCitation: string;
  referenceIndex: number | null;
  semanticScholarId: string | null;
  arxivId: string | null;
  externalUrl: string | null;
  resolvedEntityId: string | null;
  resolveConfidence: number | null;
  resolveSource: ResolutionMethod | null;
}

export interface EnrichReferenceEntryResult {
  referenceEntryId: string;
  legacyReferenceId: string | null;
  linkedPaperId: string | null;
  mergeSummary: ReferenceMetadataMergeSummary;
}

export interface ApplyReviewedReferenceMetadataResult {
  referenceEntryId: string;
  legacyReferenceId: string | null;
  linkedPaperId: string | null;
  identifiersPersisted: boolean;
  resolutionUpdated: boolean;
  fieldActions: ReferenceMetadataFieldActions;
}

export type ReferenceMergeFieldOutcome =
  | "kept_trusted_local"
  | "filled_missing"
  | "replaced_polluted"
  | "no_trustworthy_upgrade";

export interface ReferenceMetadataMergeSummary {
  title: ReferenceMergeFieldOutcome;
  authors: ReferenceMergeFieldOutcome;
  venue: ReferenceMergeFieldOutcome;
  identifiersPersisted: boolean;
  resolutionUpdated: boolean;
}

const REFERENCE_ENTRY_MUTATION_SELECT = {
  id: true,
  paperId: true,
  legacyReferenceId: true,
  title: true,
  authors: true,
  year: true,
  venue: true,
  doi: true,
  rawCitation: true,
  referenceIndex: true,
  semanticScholarId: true,
  arxivId: true,
  externalUrl: true,
  resolvedEntityId: true,
  resolveConfidence: true,
  resolveSource: true,
} as const;

type LegacyProjectionTx = Pick<typeof prisma, "reference" | "referenceEntry" | "paper">;

function hasNonEmptyValue(value: string | null | undefined): value is string {
  return Boolean(value && value.trim().length > 0);
}

function mergeNormalizedField(params: {
  localValue: string | null;
  candidateValue: string | null;
  localPolluted: boolean;
}): { value: string | null; outcome: ReferenceMergeFieldOutcome } {
  const localValue = hasNonEmptyValue(params.localValue) ? params.localValue.trim() : null;
  const candidateValue = hasNonEmptyValue(params.candidateValue)
    ? params.candidateValue.trim()
    : null;

  if (localValue && !params.localPolluted) {
    return {
      value: localValue,
      outcome: "kept_trusted_local",
    };
  }

  if (!localValue && candidateValue) {
    return {
      value: candidateValue,
      outcome: "filled_missing",
    };
  }

  if (localValue && params.localPolluted && candidateValue) {
    return {
      value: candidateValue,
      outcome: "replaced_polluted",
    };
  }

  return {
    value: localValue,
    outcome: "no_trustworthy_upgrade",
  };
}

function normalizeCandidateAuthors(authors: string[]): string | null {
  if (authors.length === 0) return null;
  return JSON.stringify(authors.map((author) => cleanReferenceText(author)).filter(Boolean));
}

function getTrustedCandidateAuthorsValue(params: {
  rawCitation: string;
  title: string;
  candidateAuthors: string[];
}): string | null {
  return candidateAuthorsPassTrustCheck(params)
    ? normalizeCandidateAuthors(params.candidateAuthors)
    : null;
}

function hasNewIdentifier(
  currentValue: string | null,
  candidateValue: string | null,
): boolean {
  return hasNonEmptyValue(candidateValue) && candidateValue !== currentValue;
}

function hasReplaceAction(fieldActions: ReferenceMetadataFieldActions): boolean {
  return Object.values(fieldActions).includes("replace");
}

function resolveFieldAction(
  fieldActions: ReferenceMetadataFieldActions,
  field: keyof ReferenceMetadataFieldActions,
): ReferenceMetadataFieldAction {
  return fieldActions[field] ?? "leave";
}

export function referenceEntryNeedsMetadataRepair(entry: {
  title: string;
  authors: string | null;
  venue: string | null;
}): boolean {
  return referenceMetadataNeedsRepair(entry);
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

export async function findReferenceEntryForPaper(
  paperId: string,
  referenceId: string,
): Promise<ReferenceEntryMutationTarget | null> {
  const entry = await prisma.referenceEntry.findFirst({
    where: {
      paperId,
      OR: [{ id: referenceId }, { legacyReferenceId: referenceId }],
    },
    select: REFERENCE_ENTRY_MUTATION_SELECT,
  });

  if (!entry) {
    return null;
  }

  return {
    ...entry,
    resolveSource: entry.resolveSource as ResolutionMethod | null,
  };
}

async function upsertLegacyReferenceProjection(
  tx: LegacyProjectionTx,
  target: ReferenceEntryMutationTarget,
  input: {
    title: string;
    authors: string | null;
    year: number | null;
    venue: string | null;
    doi: string | null;
    rawCitation: string;
    referenceIndex: number | null;
    matchedPaperId: string | null;
    matchConfidence: number | null;
    citationContext?: string | null;
    semanticScholarId: string | null;
    arxivId: string | null;
    externalUrl: string | null;
  },
): Promise<string> {
  if (target.legacyReferenceId) {
    await tx.reference.update({
      where: { id: target.legacyReferenceId },
      data: input,
    });
    return target.legacyReferenceId;
  }

  const legacyReference = await tx.reference.create({
    data: {
      paperId: target.paperId,
      ...input,
    },
  });
  await tx.referenceEntry.update({
    where: { id: target.id },
    data: { legacyReferenceId: legacyReference.id },
  });
  return legacyReference.id;
}

function mapCandidateResolutionMethod(
  source: SearchSource | "arxiv" | undefined,
): ResolutionMethod | null {
  if (source === "openalex") return "openalex_candidate";
  if (source === "crossref") return "crossref_candidate";
  if (source === "s2") return "semantic_scholar_candidate";
  if (source === "arxiv") return "arxiv_candidate";
  return null;
}

export async function enrichReferenceEntryFromCandidate(params: {
  paperId: string;
  referenceId: string;
  userId: string | null | undefined;
  candidate: Omit<S2Result, "source"> & { source?: SearchSource | "arxiv" };
}): Promise<EnrichReferenceEntryResult | null> {
  const target = await findReferenceEntryForPaper(params.paperId, params.referenceId);
  if (!target) {
    return null;
  }

  const mergedTitle = mergeNormalizedField({
    localValue: cleanReferenceText(target.title),
    candidateValue: cleanReferenceText(params.candidate.title),
    localPolluted: looksLikePollutedTitle(target.title),
  });
  const mergedAuthors = mergeNormalizedField({
    localValue: target.authors,
    candidateValue: getTrustedCandidateAuthorsValue({
      rawCitation: target.rawCitation,
      title: params.candidate.title || target.title,
      candidateAuthors: params.candidate.authors,
    }),
    localPolluted: looksLikePollutedAuthors(target.authors),
  });
  const mergedVenue = mergeNormalizedField({
    localValue: cleanReferenceText(target.venue),
    candidateValue: cleanReferenceText(params.candidate.venue),
    localPolluted: looksLikePollutedVenue(target.venue),
  });

  const title = mergedTitle.value ?? cleanReferenceText(target.title);
  const authors = mergedAuthors.value;
  const year = target.year ?? params.candidate.year;
  const venue = mergedVenue.value;
  const doi = target.doi || params.candidate.doi;
  const arxivId = target.arxivId || params.candidate.arxivId;
  const semanticScholarId = target.semanticScholarId || params.candidate.semanticScholarId;
  const externalUrl = target.externalUrl || params.candidate.externalUrl;

  const identifiers = buildIdentifierInputs({
    ...params.candidate,
    doi,
    arxivId,
    semanticScholarId,
  });
  let resolvedEntityId = target.resolvedEntityId;
  let resolveConfidence = target.resolveConfidence;
  let resolveSource = target.resolveSource;
  let resolutionUpdated = false;
  const identifiersPersisted =
    hasNewIdentifier(target.doi, doi)
    || hasNewIdentifier(target.arxivId, arxivId)
    || hasNewIdentifier(target.semanticScholarId, semanticScholarId);

  if (identifiers.length > 0 && identifiersPersisted) {
    const entity = await resolveOrCreateEntity({
      title,
      authors,
      year,
      venue,
      abstract: params.candidate.abstract,
      identifiers,
      source: mapEntitySource(params.candidate.source),
    });

    resolvedEntityId = entity.entityId;
    resolveConfidence = doi || arxivId ? 1.0 : 0.9;
    resolveSource = mapCandidateResolutionMethod(params.candidate.source);
    resolutionUpdated = true;
  }

  const linkedPaper =
    params.userId && resolvedEntityId
      ? await prisma.paper.findFirst({
          where: {
            userId: params.userId,
            entityId: resolvedEntityId,
          },
          select: { id: true },
        })
      : null;

  const updated = await prisma.$transaction(async (tx) => {
    const nextEntry = await tx.referenceEntry.update({
      where: { id: target.id },
      data: {
        title,
        authors,
        year,
        venue,
        doi,
        arxivId,
        semanticScholarId,
        externalUrl,
        resolvedEntityId,
        resolveConfidence,
        resolveSource,
      },
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });

    const legacyReferenceId = await upsertLegacyReferenceProjection(tx, target, {
      title,
      authors,
      year,
      venue,
      doi,
      rawCitation: target.rawCitation,
      referenceIndex: target.referenceIndex,
      matchedPaperId: linkedPaper?.id ?? null,
      matchConfidence: linkedPaper ? (resolveConfidence ?? 1.0) : null,
      semanticScholarId,
      arxivId,
      externalUrl,
    });

    return {
      referenceEntryId: nextEntry.id,
      legacyReferenceId,
      linkedPaperId: linkedPaper?.id ?? null,
      mergeSummary: {
        title: mergedTitle.outcome,
        authors: mergedAuthors.outcome,
        venue: mergedVenue.outcome,
        identifiersPersisted,
        resolutionUpdated,
      },
    };
  });

  return updated;
}

export async function applyReviewedReferenceMetadataDecision(params: {
  paperId: string;
  referenceId: string;
  userId: string | null | undefined;
  candidate: (Omit<S2Result, "source"> & { source?: SearchSource | "arxiv" }) | null;
  fieldActions: ReferenceMetadataFieldActions;
  persistIdentifiers: boolean;
}): Promise<ApplyReviewedReferenceMetadataResult | null> {
  const target = await findReferenceEntryForPaper(params.paperId, params.referenceId);
  if (!target) {
    return null;
  }

  const titleAction = resolveFieldAction(params.fieldActions, "title");
  const authorsAction = resolveFieldAction(params.fieldActions, "authors");
  const venueAction = resolveFieldAction(params.fieldActions, "venue");
  const anyReplace = hasReplaceAction(params.fieldActions);

  if (anyReplace && !params.candidate) {
    throw new Error("Reviewed metadata replacement requires a candidate");
  }

  if (titleAction === "suppress" || authorsAction === "suppress") {
    throw new Error("Only venue may be suppressed");
  }

  const trustedCandidateAuthors =
    authorsAction === "replace"
      ? getTrustedCandidateAuthorsValue({
        rawCitation: target.rawCitation,
        title: params.candidate?.title || target.title,
        candidateAuthors: params.candidate?.authors ?? [],
      })
      : null;

  if (authorsAction === "replace" && !trustedCandidateAuthors) {
    throw new Error("Reviewed metadata replacement requires a trustworthy author candidate");
  }

  const title =
    titleAction === "replace"
      ? cleanReferenceText(params.candidate?.title ?? "")
      : cleanReferenceText(target.title);
  const authors =
    authorsAction === "replace"
      ? trustedCandidateAuthors
      : target.authors;
  const venue =
    venueAction === "replace"
      ? cleanReferenceText(params.candidate?.venue)
      : venueAction === "suppress"
        ? null
        : cleanReferenceText(target.venue);
  const year = target.year ?? params.candidate?.year ?? null;
  const doi = params.persistIdentifiers
    ? target.doi || params.candidate?.doi || null
    : target.doi;
  const arxivId = params.persistIdentifiers
    ? target.arxivId || params.candidate?.arxivId || null
    : target.arxivId;
  const semanticScholarId = params.persistIdentifiers
    ? target.semanticScholarId || params.candidate?.semanticScholarId || null
    : target.semanticScholarId;
  const externalUrl = params.persistIdentifiers
    ? target.externalUrl || params.candidate?.externalUrl || null
    : target.externalUrl;

  const identifiers = params.candidate
    ? buildIdentifierInputs({
        ...params.candidate,
        doi,
        arxivId,
        semanticScholarId,
      })
    : [];
  let resolvedEntityId = target.resolvedEntityId;
  let resolveConfidence = target.resolveConfidence;
  let resolveSource = target.resolveSource;
  let resolutionUpdated = false;
  const identifiersPersisted =
    params.persistIdentifiers
    && (
      hasNewIdentifier(target.doi, doi)
      || hasNewIdentifier(target.arxivId, arxivId)
      || hasNewIdentifier(target.semanticScholarId, semanticScholarId)
    );

  if (params.persistIdentifiers && anyReplace && identifiers.length > 0 && identifiersPersisted) {
    const entity = await resolveOrCreateEntity({
      title,
      authors,
      year,
      venue,
      abstract: params.candidate?.abstract ?? null,
      identifiers,
      source: mapEntitySource(params.candidate?.source),
    });

    resolvedEntityId = entity.entityId;
    resolveConfidence = doi || arxivId ? 1.0 : 0.9;
    resolveSource = mapCandidateResolutionMethod(params.candidate?.source);
    resolutionUpdated = true;
  }

  const linkedPaper =
    params.userId && resolvedEntityId
      ? await prisma.paper.findFirst({
          where: {
            userId: params.userId,
            entityId: resolvedEntityId,
          },
          select: { id: true },
        })
      : null;

  const updated = await prisma.$transaction(async (tx) => {
    const nextEntry = await tx.referenceEntry.update({
      where: { id: target.id },
      data: {
        title,
        authors,
        year,
        venue,
        doi,
        arxivId,
        semanticScholarId,
        externalUrl,
        resolvedEntityId,
        resolveConfidence,
        resolveSource,
      },
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });

    const legacyReferenceId = await upsertLegacyReferenceProjection(tx, target, {
      title,
      authors,
      year,
      venue,
      doi,
      rawCitation: target.rawCitation,
      referenceIndex: target.referenceIndex,
      matchedPaperId: linkedPaper?.id ?? null,
      matchConfidence: linkedPaper ? (resolveConfidence ?? 1.0) : null,
      semanticScholarId,
      arxivId,
      externalUrl,
    });

    return {
      referenceEntryId: nextEntry.id,
      legacyReferenceId,
      linkedPaperId: linkedPaper?.id ?? null,
      identifiersPersisted,
      resolutionUpdated,
      fieldActions: params.fieldActions,
    };
  });

  return updated;
}

export async function projectReferenceEntryImportLink(params: {
  paperId: string;
  referenceId: string;
  linkedPaperId: string;
  linkedPaperEntityId: string | null;
}): Promise<ReferenceEntryProjectionResult | null> {
  const target = await findReferenceEntryForPaper(params.paperId, params.referenceId);
  if (!target) {
    return null;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const nextEntry = await tx.referenceEntry.update({
      where: { id: target.id },
      data: params.linkedPaperEntityId
        ? {
            resolvedEntityId: params.linkedPaperEntityId,
            resolveConfidence: target.resolveConfidence ?? 1.0,
            resolveSource: target.resolveSource ?? "identifier_exact",
          }
        : {},
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });

    const legacyReferenceId = await upsertLegacyReferenceProjection(tx, target, {
      title: target.title,
      authors: target.authors,
      year: target.year,
      venue: target.venue,
      doi: target.doi,
      rawCitation: target.rawCitation,
      referenceIndex: target.referenceIndex,
      matchedPaperId: params.linkedPaperId,
      matchConfidence: 1.0,
      semanticScholarId: target.semanticScholarId,
      arxivId: target.arxivId,
      externalUrl: target.externalUrl,
    });

    return {
      referenceEntryId: nextEntry.id,
      legacyReferenceId,
    };
  });

  return updated;
}

export async function deleteReferenceEntryWithLegacyProjection(
  paperId: string,
  referenceId: string,
): Promise<DeleteReferenceEntryResult | null> {
  const referenceEntry = await prisma.referenceEntry.findFirst({
    where: {
      paperId,
      OR: [{ id: referenceId }, { legacyReferenceId: referenceId }],
    },
    select: {
      id: true,
      legacyReferenceId: true,
    },
  });

  if (!referenceEntry) {
    return null;
  }

  await prisma.$transaction(async (tx) => {
    if (referenceEntry.legacyReferenceId) {
      await tx.reference.deleteMany({
        where: {
          id: referenceEntry.legacyReferenceId,
          paperId,
        },
      });
    }

    await tx.referenceEntry.delete({
      where: { id: referenceEntry.id },
    });

    await syncPaperReferenceState(paperId, tx);
  });

  return {
    referenceEntryId: referenceEntry.id,
    legacyReferenceId: referenceEntry.legacyReferenceId,
  };
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
