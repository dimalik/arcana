import { prisma } from "../prisma";
import { normalizeTitle } from "./match";
import { buildNormalizedCitationContext } from "./citation-context-normalization";
import {
  restoreReferenceTitleCasing,
  sanitizeReferenceMetadataForDisplay,
} from "./reference-quality";

interface LocalPaperCandidate {
  id: string;
  entityId: string | null;
  title: string;
  year: number | null;
  authors: string | null;
  createdAt: Date;
}

interface ResolvedEntityDisplay {
  id: string;
  title: string;
}

export interface PaperReferenceView {
  id: string;
  referenceEntryId: string;
  legacyReferenceId: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  rawCitation: string;
  referenceIndex: number | null;
  matchedPaperId: string | null;
  matchConfidence: number | null;
  citationContext: string | null;
  semanticScholarId: string | null;
  arxivId: string | null;
  externalUrl: string | null;
  matchedPaper: {
    id: string;
    title: string;
    year: number | null;
    authors: string | null;
  } | null;
  linkState: "canonical_entity_linked" | "import_dedup_only_reusable" | "unresolved";
  importReusablePaperId: string | null;
  resolvedEntityId: string | null;
  resolveConfidence: number | null;
  resolveSource: string | null;
}

interface ReferenceEntryRecord {
  id: string;
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
  resolveSource: string | null;
  createdAt: Date;
  citationMentions: Array<{
    citationText: string | null;
    excerpt: string;
    createdAt: Date;
  }>;
}

function sanitizeReferenceEntryDisplay(entry: ReferenceEntryRecord): {
  title: string;
  authors: string | null;
  venue: string | null;
  rawCitation: string;
} {
  return sanitizeReferenceMetadataForDisplay(entry);
}

function buildCitationContext(
  mentions: Array<{ citationText: string | null; excerpt: string; createdAt: Date }>,
): string | null {
  if (mentions.length === 0) return null;

  return buildNormalizedCitationContext(
    [...mentions].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    ),
  );
}

function getImportReusablePaper(
  title: string,
  localPaperByNormalizedTitle: Map<string, LocalPaperCandidate>,
): LocalPaperCandidate | null {
  const normalizedTitle = normalizeTitle(title);
  if (normalizedTitle.length <= 10) return null;
  return localPaperByNormalizedTitle.get(normalizedTitle) ?? null;
}

export function mapReferenceEntryToView(
  entry: ReferenceEntryRecord,
  localPaperByEntityId: Map<string, LocalPaperCandidate>,
  localPaperByNormalizedTitle: Map<string, LocalPaperCandidate>,
  resolvedEntityById: Map<string, ResolvedEntityDisplay> = new Map(),
): PaperReferenceView {
  const display = sanitizeReferenceEntryDisplay(entry);
  const resolvedEntityDisplay = entry.resolvedEntityId
    ? resolvedEntityById.get(entry.resolvedEntityId) ?? null
    : null;
  const displayTitle = resolvedEntityDisplay?.title
    ? restoreReferenceTitleCasing(resolvedEntityDisplay.title)
    : display.title;
  const matchedPaper = entry.resolvedEntityId
    ? localPaperByEntityId.get(entry.resolvedEntityId) ?? null
    : null;
  const importReusablePaper = matchedPaper
    ? null
    : getImportReusablePaper(displayTitle, localPaperByNormalizedTitle);
  const linkState = matchedPaper
    ? "canonical_entity_linked"
    : importReusablePaper
      ? "import_dedup_only_reusable"
      : "unresolved";

  return {
    id: entry.legacyReferenceId ?? entry.id,
    referenceEntryId: entry.id,
    legacyReferenceId: entry.legacyReferenceId,
    title: displayTitle,
    authors: display.authors,
    year: entry.year,
    venue: display.venue,
    doi: entry.doi,
    rawCitation: display.rawCitation,
    referenceIndex: entry.referenceIndex,
    matchedPaperId: matchedPaper?.id ?? null,
    matchConfidence: matchedPaper ? (entry.resolveConfidence ?? 1.0) : null,
    citationContext: buildCitationContext(entry.citationMentions),
    semanticScholarId: entry.semanticScholarId,
    arxivId: entry.arxivId,
    externalUrl: entry.externalUrl,
    matchedPaper: matchedPaper
      ? {
          id: matchedPaper.id,
          title: matchedPaper.title,
          year: matchedPaper.year,
          authors: matchedPaper.authors,
        }
      : null,
    linkState,
    importReusablePaperId: importReusablePaper?.id ?? null,
    resolvedEntityId: entry.resolvedEntityId,
    resolveConfidence: entry.resolveConfidence,
    resolveSource: entry.resolveSource,
  };
}

export async function listPaperReferenceViews(
  paperId: string,
  userId: string | null | undefined,
): Promise<PaperReferenceView[]> {
  const referenceEntries = await prisma.referenceEntry.findMany({
    where: { paperId },
    orderBy: [{ referenceIndex: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
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
      createdAt: true,
      citationMentions: {
        select: {
          excerpt: true,
          citationText: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const [localPapers, resolvedEntities] = await Promise.all([
    loadLocalLibraryPapers(paperId, userId),
    loadResolvedEntityDisplay(referenceEntries),
  ]);

  return mapReferenceEntriesToViews(referenceEntries, localPapers, resolvedEntities);
}

export async function getPaperReferenceViewById(
  paperId: string,
  userId: string | null | undefined,
  referenceId: string,
): Promise<PaperReferenceView | null> {
  const [localPapers, referenceEntry] = await Promise.all([
    loadLocalLibraryPapers(paperId, userId),
    prisma.referenceEntry.findFirst({
      where: {
        paperId,
        OR: [{ id: referenceId }, { legacyReferenceId: referenceId }],
      },
      select: {
        id: true,
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
        createdAt: true,
        citationMentions: {
          select: {
            excerpt: true,
            citationText: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
  ]);

  if (!referenceEntry) return null;
  const resolvedEntities = await loadResolvedEntityDisplay([referenceEntry]);
  return mapReferenceEntriesToViews([referenceEntry], localPapers, resolvedEntities)[0] ?? null;
}

async function loadLocalLibraryPapers(
  paperId: string,
  userId: string | null | undefined,
): Promise<LocalPaperCandidate[]> {
  if (!userId) {
    return [];
  }

  return prisma.paper.findMany({
    where: {
      userId,
      id: { not: paperId },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      entityId: true,
      title: true,
      year: true,
      authors: true,
      createdAt: true,
    },
  });
}

function mapReferenceEntriesToViews(
  referenceEntries: ReferenceEntryRecord[],
  localPapers: LocalPaperCandidate[],
  resolvedEntities: ResolvedEntityDisplay[],
): PaperReferenceView[] {
  const localPaperByEntityId = new Map<string, LocalPaperCandidate>();
  const localPaperByNormalizedTitle = new Map<string, LocalPaperCandidate>();
  const resolvedEntityById = new Map<string, ResolvedEntityDisplay>();

  for (const paper of localPapers) {
    if (paper.entityId && !localPaperByEntityId.has(paper.entityId)) {
      localPaperByEntityId.set(paper.entityId, paper);
    }

    const normalizedTitle = normalizeTitle(paper.title);
    if (normalizedTitle.length > 10 && !localPaperByNormalizedTitle.has(normalizedTitle)) {
      localPaperByNormalizedTitle.set(normalizedTitle, paper);
    }
  }

  for (const entity of resolvedEntities) {
    resolvedEntityById.set(entity.id, entity);
  }

  return referenceEntries.map((entry) =>
    mapReferenceEntryToView(
      entry,
      localPaperByEntityId,
      localPaperByNormalizedTitle,
      resolvedEntityById,
    ),
  );
}

async function loadResolvedEntityDisplay(
  referenceEntries: ReferenceEntryRecord[],
): Promise<ResolvedEntityDisplay[]> {
  const entityIds = Array.from(
    new Set(
      referenceEntries
        .map((entry) => entry.resolvedEntityId)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  if (entityIds.length === 0) {
    return [];
  }

  return prisma.paperEntity.findMany({
    where: {
      id: { in: entityIds },
    },
    select: {
      id: true,
      title: true,
    },
  });
}
