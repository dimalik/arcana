import { prisma } from "../prisma";
import { normalizeTitle } from "./match";

interface LocalPaperCandidate {
  id: string;
  entityId: string | null;
  title: string;
  year: number | null;
  authors: string | null;
  createdAt: Date;
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

const LEADING_CITATION_MARKER_RE = /^[A-Z][A-Z0-9]{1,12}\s*\+\s*\d+\]\s*/;
const VENUE_CITATION_MARKER_RE = /^[A-Z][A-Z0-9]{1,12}\s*\+\s*\d{2,4}$/;
const STANDALONE_YEAR_RE = /^\(?\d{4}[a-z]?\)?$/i;
const TRAILING_YEAR_RE = /[\s,.;:()-]*\b\d{4}[a-z]?\)?\.?$/i;
const NUMERIC_CITATION_MARKER_RE = /^\[\d+(?:\s*[-,]\s*\d+)*\]$/;
const AUTHOR_KEY_CITATION_MARKER_RE = /^\[[A-Z][A-Za-z0-9]*(?:\s*\+\s*\d{2,4}|\d{2,4})(?:\s*,\s*[A-Z][A-Za-z0-9]*(?:\s*\+\s*\d{2,4}|\d{2,4}))*\]$/;
const AUTHOR_YEAR_PAREN_CITATION_MARKER_RE = /^\([A-Z][^()]{0,120}?\bet al\.,\s*\d{4}[a-z]?\)$/;

function cleanReferenceText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/([a-z]{2,})-\s*\n\s*([a-z]{2,})/g, "$1$2")
    .replace(LEADING_CITATION_MARKER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitCitationSentences(rawCitation: string): string[] {
  return cleanReferenceText(rawCitation)
    .split(/\.\s+/)
    .map((part) => part.trim().replace(/\.+$/, ""))
    .filter(Boolean);
}

function looksLikePollutedTitle(title: string): boolean {
  if (!title) return false;
  if (LEADING_CITATION_MARKER_RE.test(title)) return true;
  const commaCount = (title.match(/,/g) ?? []).length;
  return commaCount >= 3 || /\bet al\b/i.test(title);
}

function cleanDerivedTitle(title: string): string {
  return cleanReferenceText(title)
    .replace(TRAILING_YEAR_RE, "")
    .trim()
    .replace(/[.,;:]+$/, "")
    .trim();
}

function deriveTitleFromRawCitation(rawCitation: string): string | null {
  const cleaned = cleanReferenceText(rawCitation);
  const authorRemainder =
    cleaned.match(/\band\s+[^.]+?\.\s+(.+)$/i)?.[1]
    ?? cleaned.match(/\bet al\.\s+(.+)$/i)?.[1]
    ?? null;

  const remainder = authorRemainder
    ? authorRemainder.replace(/^\(?\d{4}[a-z]?\)?\.\s+/i, "").trim()
    : null;

  if (remainder) {
    const dotted = remainder.match(/^([^.;]+?)\.\s+/)?.[1];
    const commaYear = remainder.match(/^([^.;]+?),\s*\d{4}[a-z]?\.?$/i)?.[1];
    const derived = cleanDerivedTitle(dotted ?? commaYear ?? remainder);
    if (derived) return derived;
  }

  const parts = splitCitationSentences(rawCitation);
  if (parts.length >= 3 && STANDALONE_YEAR_RE.test(parts[1] ?? "")) {
    return cleanDerivedTitle(parts[2] ?? "") || null;
  }
  if (parts.length >= 2) {
    return cleanDerivedTitle(parts[1] ?? "") || null;
  }
  return null;
}

function parseAuthorsJson(authors: string | null): string[] | null {
  if (!authors) return null;
  try {
    const parsed = JSON.parse(authors) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((value) => (typeof value === "string" ? cleanReferenceText(value) : ""))
      .filter(Boolean);
  } catch {
    return null;
  }
}

function looksLikePollutedAuthors(authors: string[]): boolean {
  return authors.some((author) => author.includes("]") || /\s\+\s\d+\]/.test(author));
}

function deriveAuthorsFromRawCitation(rawCitation: string, title: string): string[] | null {
  const cleaned = cleanReferenceText(rawCitation);
  const titleIndex = title
    ? cleaned.toLowerCase().indexOf(title.toLowerCase())
    : -1;
  const authorBlock = titleIndex > 0
    ? cleaned.slice(0, titleIndex)
    : splitCitationSentences(rawCitation)[0] ?? cleaned;

  const normalized = authorBlock
    .replace(/\(?\d{4}[a-z]?\)?\.?\s*$/i, "")
    .replace(/[.;:\s]+$/g, "")
    .replace(/\bet al\b\.?/gi, "")
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : null;
}

function sanitizeReferenceEntryDisplay(entry: ReferenceEntryRecord): {
  title: string;
  authors: string | null;
  venue: string | null;
  rawCitation: string;
} {
  const cleanedTitle = cleanReferenceText(entry.title);
  const derivedTitle = deriveTitleFromRawCitation(entry.rawCitation);
  const title = looksLikePollutedTitle(cleanedTitle)
    ? (derivedTitle ?? cleanedTitle)
    : cleanedTitle;

  const parsedAuthors = parseAuthorsJson(entry.authors);
  const displayAuthors = !parsedAuthors || looksLikePollutedAuthors(parsedAuthors)
    ? deriveAuthorsFromRawCitation(entry.rawCitation, title || derivedTitle || "")
    : parsedAuthors;
  const cleanedVenue = cleanReferenceText(entry.venue);
  const venue = looksLikePollutedVenue(cleanedVenue) ? null : cleanedVenue || null;

  return {
    title: title || cleanedTitle || cleanReferenceText(entry.rawCitation),
    authors: displayAuthors ? JSON.stringify(displayAuthors) : entry.authors,
    venue,
    rawCitation: cleanReferenceText(entry.rawCitation),
  };
}

function buildCitationContext(
  mentions: Array<{ citationText: string | null; excerpt: string; createdAt: Date }>,
): string | null {
  if (mentions.length === 0) return null;

  const seen = new Set<string>();
  const excerpts: string[] = [];
  for (const mention of [...mentions].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())) {
    const excerpt = normalizeCitationContext(mention.excerpt, mention.citationText);
    if (!excerpt || seen.has(excerpt)) continue;
    seen.add(excerpt);
    excerpts.push(excerpt);
  }

  return excerpts.length > 0 ? excerpts.join("; ") : null;
}

function looksLikePollutedVenue(venue: string): boolean {
  return VENUE_CITATION_MARKER_RE.test(venue);
}

function normalizeCitationContext(
  excerpt: string | null | undefined,
  citationText: string | null | undefined,
): string {
  let value = (excerpt ?? "")
    .replace(/([a-z]{2,})-\s*\n\s*([a-z]{2,})/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

  if (!value) return "";

  const marker = normalizeCitationMarker(citationText);
  if (marker) {
    const markerPattern = escapeRegex(marker).replace(/\s+/g, "\\s+");
    value = value.replace(new RegExp(markerPattern, "g"), " ");
  }

  return value
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/\s+([)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeCitationMarker(citationText: string | null | undefined): string | null {
  const marker = (citationText ?? "").trim().replace(/\s+/g, " ");
  if (!marker) return null;
  if (NUMERIC_CITATION_MARKER_RE.test(marker)) return marker;
  if (AUTHOR_KEY_CITATION_MARKER_RE.test(marker)) return marker;
  if (AUTHOR_YEAR_PAREN_CITATION_MARKER_RE.test(marker)) return marker;
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
): PaperReferenceView {
  const display = sanitizeReferenceEntryDisplay(entry);
  const matchedPaper = entry.resolvedEntityId
    ? localPaperByEntityId.get(entry.resolvedEntityId) ?? null
    : null;
  const importReusablePaper = matchedPaper
    ? null
    : getImportReusablePaper(display.title, localPaperByNormalizedTitle);
  const linkState = matchedPaper
    ? "canonical_entity_linked"
    : importReusablePaper
      ? "import_dedup_only_reusable"
      : "unresolved";

  return {
    id: entry.legacyReferenceId ?? entry.id,
    referenceEntryId: entry.id,
    legacyReferenceId: entry.legacyReferenceId,
    title: display.title,
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
  const localPapers = await loadLocalLibraryPapers(paperId, userId);
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

  return mapReferenceEntriesToViews(referenceEntries, localPapers);
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
  return mapReferenceEntriesToViews([referenceEntry], localPapers)[0] ?? null;
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
): PaperReferenceView[] {
  const localPaperByEntityId = new Map<string, LocalPaperCandidate>();
  const localPaperByNormalizedTitle = new Map<string, LocalPaperCandidate>();

  for (const paper of localPapers) {
    if (paper.entityId && !localPaperByEntityId.has(paper.entityId)) {
      localPaperByEntityId.set(paper.entityId, paper);
    }

    const normalizedTitle = normalizeTitle(paper.title);
    if (normalizedTitle.length > 10 && !localPaperByNormalizedTitle.has(normalizedTitle)) {
      localPaperByNormalizedTitle.set(normalizedTitle, paper);
    }
  }

  return referenceEntries.map((entry) =>
    mapReferenceEntryToView(entry, localPaperByEntityId, localPaperByNormalizedTitle),
  );
}
