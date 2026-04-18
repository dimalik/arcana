import { createRelationAssertion } from "../assertions/relation-assertion-service";
import { projectLegacyRelation } from "../assertions/legacy-projection";
import { normalizeIdentifier } from "../canonical/normalize";
import {
  createReferenceEntry,
  resolveReferenceEntity,
} from "../citations/reference-entry-service";
import { prisma } from "../prisma";
import { syncPaperReferenceState } from "./reference-state";
import { findBestMatch } from "./match";
import { isPromotableResolution } from "./resolve";
import type { ReferenceExtractionCandidate } from "./types";

interface LibraryPaperForReferences {
  id: string;
  title: string;
  entityId: string | null;
  doi: string | null;
  arxivId: string | null;
}

export interface PersistExtractedReferencesParams {
  paperId: string;
  paperUserId?: string | null;
  sourceEntityId?: string | null;
  references: ReferenceExtractionCandidate[];
  provenance: string;
  extractorVersion: string | null;
}

export interface PersistExtractedReferencesResult {
  storedReferences: number;
  promotedPaperEdges: number;
  promotedEntityAssertions: number;
  titleHintMatches: number;
}

export async function persistExtractedReferences(
  params: PersistExtractedReferencesParams,
): Promise<PersistExtractedReferencesResult> {
  await prisma.reference.deleteMany({ where: { paperId: params.paperId } });
  await prisma.citationMention.deleteMany({ where: { paperId: params.paperId } });
  await prisma.referenceEntry.deleteMany({ where: { paperId: params.paperId } });

  const libraryPapers = await prisma.paper.findMany({
    where: {
      id: { not: params.paperId },
      ...(params.paperUserId ? { userId: params.paperUserId } : {}),
    },
    select: {
      id: true,
      title: true,
      entityId: true,
      doi: true,
      arxivId: true,
    },
  });
  const libraryPaperByEntityId = new Map<string, LibraryPaperForReferences>();
  for (const paper of libraryPapers) {
    if (paper.entityId) {
      libraryPaperByEntityId.set(paper.entityId, paper);
    }
  }

  let promotedPaperEdges = 0;
  let promotedEntityAssertions = 0;
  let titleHintMatches = 0;
  let storedReferences = 0;

  for (const ref of params.references.slice(0, 200)) {
    const refTitle =
      ref.title?.trim() ||
      ref.rawCitation.trim().slice(0, 300) ||
      `Reference ${ref.referenceIndex ?? ""}`.trim();
    if (!refTitle) continue;

    const strongPaperMatch = findStrongLibraryPaperMatch(ref, libraryPapers);
    const titleHint =
      strongPaperMatch
        ? { paperId: strongPaperMatch.id, confidence: 1.0 }
        :
      findBestMatch(
        refTitle,
        libraryPapers.map((paper) => ({ id: paper.id, title: paper.title })),
      );

    if (titleHint && !strongPaperMatch) {
      titleHintMatches += 1;
    }

    const legacyReference = await prisma.reference.create({
      data: {
        paperId: params.paperId,
        title: refTitle,
        authors: ref.authors ? JSON.stringify(ref.authors) : null,
        year: ref.year ?? null,
        venue: ref.venue ?? null,
        doi: ref.doi ?? null,
        arxivId: ref.arxivId ?? null,
        rawCitation: ref.rawCitation || refTitle,
        referenceIndex: ref.referenceIndex ?? null,
        matchedPaperId: titleHint?.paperId ?? null,
        matchConfidence: titleHint?.confidence ?? null,
      },
    });

    const referenceEntry = await createReferenceEntry({
      paperId: params.paperId,
      title: refTitle,
      authors: ref.authors ? JSON.stringify(ref.authors) : null,
      year: ref.year ?? null,
      venue: ref.venue ?? null,
      doi: ref.doi ?? null,
      arxivId: ref.arxivId ?? null,
      rawCitation: ref.rawCitation || refTitle,
      referenceIndex: ref.referenceIndex ?? null,
      provenance: params.provenance,
      extractorVersion: params.extractorVersion,
      legacyReferenceId: legacyReference.id,
    });

    const resolution = await resolveReferenceEntity(referenceEntry.id, {
      doi: ref.doi ?? null,
      arxivId: ref.arxivId ?? null,
      title: refTitle,
      authors: ref.authors ?? null,
      year: ref.year ?? null,
      venue: ref.venue ?? null,
      rawCitation: ref.rawCitation || refTitle,
    });

    const resolvedPaperMatch = resolution.resolvedEntityId
      ? libraryPaperByEntityId.get(resolution.resolvedEntityId) ?? null
      : null;
    const promotableResolution = isPromotableResolution({
      resolveSource: resolution.resolveSource,
      resolveConfidence: resolution.resolveConfidence,
      matchedFieldCount: resolution.matchedFieldCount,
    });
    const promotablePaperMatch =
      strongPaperMatch ?? (promotableResolution ? resolvedPaperMatch : null);

    if (
      promotablePaperMatch &&
      titleHint?.paperId !== promotablePaperMatch.id
    ) {
      await prisma.reference.update({
        where: { id: legacyReference.id },
        data: {
          matchedPaperId: promotablePaperMatch.id,
          matchConfidence: 1.0,
        },
      });
    }

    if (promotablePaperMatch) {
      promotedPaperEdges += 1;
      await prisma.paperRelation
        .create({
          data: {
            sourcePaperId: params.paperId,
            targetPaperId: promotablePaperMatch.id,
            relationType: "cites",
            description: `Cited in references as: "${refTitle}"`,
            confidence: 1.0,
            isAutoGenerated: true,
          },
        })
        .catch(() => {});
    }

    if (
      params.sourceEntityId &&
      resolution.resolvedEntityId &&
      promotableResolution &&
      resolution.resolvedEntityId !== params.sourceEntityId
    ) {
      promotedEntityAssertions += 1;
      await createRelationAssertion({
        sourceEntityId: params.sourceEntityId,
        targetEntityId: resolution.resolvedEntityId,
        sourcePaperId: params.paperId,
        relationType: "cites",
        description: `Cited in references as: "${refTitle}"`,
        confidence: resolution.resolveConfidence ?? 1.0,
        provenance: "reference_match",
        extractorVersion: params.extractorVersion,
      });

      if (promotablePaperMatch?.entityId === resolution.resolvedEntityId) {
        await projectLegacyRelation(
          params.paperId,
          promotablePaperMatch.id,
          params.sourceEntityId,
          resolution.resolvedEntityId,
        );
      }
    }

    storedReferences += 1;
  }

  await syncPaperReferenceState(params.paperId);

  return {
    storedReferences,
    promotedPaperEdges,
    promotedEntityAssertions,
    titleHintMatches,
  };
}

function findStrongLibraryPaperMatch(
  ref: Pick<ReferenceExtractionCandidate, "doi" | "arxivId">,
  libraryPapers: LibraryPaperForReferences[],
) {
  if (ref.doi) {
    const normalizedRefDoi = normalizeIdentifier("doi", ref.doi);
    const doiMatch = libraryPapers.find(
      (paper) =>
        paper.doi &&
        normalizeIdentifier("doi", paper.doi) === normalizedRefDoi,
    );
    if (doiMatch) return doiMatch;
  }

  if (ref.arxivId) {
    const normalizedRefArxiv = normalizeIdentifier("arxiv", ref.arxivId);
    const arxivMatch = libraryPapers.find(
      (paper) =>
        paper.arxivId &&
        normalizeIdentifier("arxiv", paper.arxivId) === normalizedRefArxiv,
    );
    if (arxivMatch) {
      return arxivMatch;
    }
  }

  return null;
}
