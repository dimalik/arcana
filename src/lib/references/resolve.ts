import { createHash } from "crypto";

import { normalizeIdentifier } from "../canonical/normalize";
import { fetchArxivMetadata, searchArxivByTitle } from "../import/arxiv";
import {
  searchAllSources,
  type S2Result,
  type SearchSource,
} from "../import/semantic-scholar";
import { extractDoiFromUrl, extractUrlContent, fetchDoiMetadata } from "../import/url";

import { normalizeTitle, titleSimilarity } from "./match";
import { CACHE_TTL, withCachedLookup } from "./resolver-cache";
import type { ResolutionMethod } from "./types";

const CANDIDATE_RESOLUTION_METHODS: Record<
  ResolverCandidateSource,
  Extract<
    ResolutionMethod,
    | "openalex_candidate"
    | "crossref_candidate"
    | "semantic_scholar_candidate"
    | "arxiv_candidate"
  >
> = {
  openalex: "openalex_candidate",
  crossref: "crossref_candidate",
  s2: "semantic_scholar_candidate",
  arxiv: "arxiv_candidate",
};

const EXACT_RESOLUTION_METHODS = new Set<ResolutionMethod>([
  "doi_exact",
  "arxiv_exact",
  "identifier_exact",
]);

const CANDIDATE_PROMOTION_METHODS = new Set<ResolutionMethod>(
  Object.values(CANDIDATE_RESOLUTION_METHODS),
);

export const MIN_CANDIDATE_RESOLUTION_CONFIDENCE = 0.78;
export const MIN_CANDIDATE_PROMOTION_CONFIDENCE = 0.9;
const DOI_REGEX = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;
const ARXIV_REGEX =
  /\barxiv(?:\s+preprint)?\s*(?::)?\s*(?:abs\/)?((?:\d{4}\.\d{4,5}(?:v\d+)?)|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?))(?:\s*\[[^\]]*\]?)?/i;
const NON_SCHOLARLY_URL_REGEX = /\bhttps?:\/\/(?!doi\.org\/|dx\.doi\.org\/|arxiv\.org\/|openreview\.net\/|aclanthology\.org\/|proceedings\.neurips\.cc\/)[^\s]+/i;
const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s]+(?:\s+[^\s]+){0,8}/i;
const SCHOLARLY_HOST_REGEX =
  /(?:^|\.)((?:doi|dx\.doi|arxiv|openreview|aclanthology)\.org|proceedings\.neurips\.cc|papers\.nips\.cc|proceedings\.mlr\.press|ieeexplore\.ieee\.org|dl\.acm\.org|link\.springer\.com|openaccess\.thecvf\.com)$/i;

type ResolverCandidateSource = SearchSource | "arxiv";
type ResolverCandidate = Omit<S2Result, "source"> & {
  source?: ResolverCandidateSource;
};

export interface ReferenceResolutionLookupInput {
  title: string;
  authors?: string[] | string | null;
  year?: number | null;
  venue?: string | null;
  rawCitation?: string | null;
  doi?: string | null;
  arxivId?: string | null;
}

export interface OnlineResolutionResult {
  candidate: ResolverCandidate;
  resolutionMethod: ResolutionMethod;
  resolutionConfidence: number;
  matchedFieldCount: number;
  matchedIdentifiers: Array<{ type: string; value: string }>;
  evidence: string[];
}

interface CandidateScore {
  confidence: number;
  matchedFieldCount: number;
  matchedIdentifiers: Array<{ type: string; value: string }>;
  evidence: string[];
  hardReject: boolean;
}

export async function resolveReferenceOnline(
  input: ReferenceResolutionLookupInput,
): Promise<OnlineResolutionResult | null> {
  const normalizedInput = normalizeLookupInput(input);
  if (isLikelyNonScholarlyWebReference(normalizedInput)) {
    return null;
  }

  const exactResolution = await resolveReferenceByExactIdentifier(normalizedInput);
  if (exactResolution) {
    return exactResolution;
  }

  const enrichedInput = await enrichLookupInputFromReferenceUrl(normalizedInput);
  if (enrichedInput.doi !== normalizedInput.doi || enrichedInput.arxivId !== normalizedInput.arxivId) {
    const enrichedExactResolution = await resolveReferenceByExactIdentifier(enrichedInput);
    if (enrichedExactResolution) {
      return enrichedExactResolution;
    }
  }

  const query = buildResolverQuery(enrichedInput);
  if (!query) return null;

  const candidates = await loadResolverCandidates(
    query,
    enrichedInput.year ?? null,
    enrichedInput,
  );
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreResolverCandidate(enrichedInput, candidate),
    }))
    .filter(
      (
        entry,
      ): entry is {
        candidate: ResolverCandidate & { source: ResolverCandidateSource };
        score: CandidateScore;
      } => Boolean(entry.candidate.source && !entry.score.hardReject),
    )
    .sort((a, b) => {
      if (b.score.confidence !== a.score.confidence) {
        return b.score.confidence - a.score.confidence;
      }
      if (b.score.matchedFieldCount !== a.score.matchedFieldCount) {
        return b.score.matchedFieldCount - a.score.matchedFieldCount;
      }
      return (b.candidate.citationCount ?? -1) - (a.candidate.citationCount ?? -1);
    });

  const best = scored[0];
  if (!best || best.score.confidence < MIN_CANDIDATE_RESOLUTION_CONFIDENCE) {
    return null;
  }

  return {
    candidate: best.candidate,
    resolutionMethod: CANDIDATE_RESOLUTION_METHODS[best.candidate.source],
    resolutionConfidence: best.score.confidence,
    matchedFieldCount: best.score.matchedFieldCount,
    matchedIdentifiers: best.score.matchedIdentifiers,
    evidence: best.score.evidence,
  };
}

export function isPromotableResolution(input: {
  resolveSource: ResolutionMethod | string | null;
  resolveConfidence: number | null;
  matchedFieldCount?: number;
}): boolean {
  if (!input.resolveSource) return false;
  if (EXACT_RESOLUTION_METHODS.has(input.resolveSource as ResolutionMethod)) {
    return true;
  }

  if (!CANDIDATE_PROMOTION_METHODS.has(input.resolveSource as ResolutionMethod)) {
    return false;
  }

  return (
    (input.resolveConfidence ?? 0) >= MIN_CANDIDATE_PROMOTION_CONFIDENCE &&
    (input.matchedFieldCount ?? 0) >= 2
  );
}

export function scoreResolverCandidate(
  input: ReferenceResolutionLookupInput,
  candidate: Pick<
    ResolverCandidate,
    "title" | "authors" | "year" | "venue" | "doi" | "arxivId" | "semanticScholarId"
  >,
): CandidateScore {
  const evidence: string[] = [];
  const matchedIdentifiers: Array<{ type: string; value: string }> = [];

  const titleScore = titleSimilarity(input.title, candidate.title);
  if (titleScore < 0.58) {
    return {
      confidence: 0,
      matchedFieldCount: 0,
      matchedIdentifiers: [],
      evidence: [],
      hardReject: true,
    };
  }

  let matchedFieldCount = 0;
  if (titleScore >= 0.8) {
    matchedFieldCount += 1;
    evidence.push(`title:${titleScore.toFixed(2)}`);
  }

  const refDoi = input.doi ? normalizeIdentifier("doi", input.doi) : null;
  const candidateDoi = candidate.doi
    ? normalizeIdentifier("doi", candidate.doi)
    : null;
  const refArxiv = input.arxivId
    ? normalizeIdentifier("arxiv", input.arxivId)
    : null;
  const candidateArxiv = candidate.arxivId
    ? normalizeIdentifier("arxiv", candidate.arxivId)
    : null;

  let identifierScore = 0;
  if (refDoi && candidateDoi) {
    if (refDoi !== candidateDoi) {
      return {
        confidence: 0,
        matchedFieldCount: 0,
        matchedIdentifiers: [],
        evidence: [],
        hardReject: true,
      };
    }
    identifierScore = 1;
    matchedFieldCount += 1;
    evidence.push("doi_exact");
  }

  if (refArxiv && candidateArxiv) {
    if (refArxiv !== candidateArxiv) {
      return {
        confidence: 0,
        matchedFieldCount: 0,
        matchedIdentifiers: [],
        evidence: [],
        hardReject: true,
      };
    }
    identifierScore = 1;
    matchedFieldCount += 1;
    evidence.push("arxiv_exact");
  }

  if (candidateDoi) {
    matchedIdentifiers.push({ type: "doi", value: candidateDoi });
  }
  if (candidateArxiv) {
    matchedIdentifiers.push({ type: "arxiv", value: candidateArxiv });
  }
  if (candidate.semanticScholarId) {
    if (candidate.semanticScholarId.startsWith("https://openalex.org/")) {
      matchedIdentifiers.push({
        type: "openalex",
        value: candidate.semanticScholarId,
      });
    } else if (candidate.semanticScholarId.startsWith("s2:")) {
      matchedIdentifiers.push({
        type: "semantic_scholar",
        value: candidate.semanticScholarId.slice(3),
      });
    }
  }

  const referenceAuthors = toAuthorList(input.authors);
  const candidateAuthors = toAuthorList(candidate.authors);
  const authorScore = computeAuthorScore(referenceAuthors, candidateAuthors);
  if (authorScore >= 0.5) {
    matchedFieldCount += 1;
    evidence.push(authorScore >= 0.9 ? "author:first" : `author:${authorScore.toFixed(2)}`);
  }

  const yearScore = computeYearScore(input.year ?? null, candidate.year ?? null);
  if (yearScore >= 1) {
    matchedFieldCount += 1;
    evidence.push(`year:${candidate.year}`);
  } else if (yearScore > 0) {
    evidence.push(`year_close:${input.year}->${candidate.year}`);
  }

  const venueScore = computeVenueScore(input.venue ?? null, candidate.venue ?? null);
  if (venueScore >= 0.75) {
    matchedFieldCount += 1;
    evidence.push(`venue:${normalizeTitle(candidate.venue ?? "")}`);
  }

  const confidence = clamp01(
    titleScore * 0.68 +
      authorScore * 0.12 +
      yearScore * 0.12 +
      venueScore * 0.04 +
      identifierScore * 0.16,
  );

  return {
    confidence,
    matchedFieldCount,
    matchedIdentifiers,
    evidence,
    hardReject: false,
  };
}

function buildResolverQuery(input: ReferenceResolutionLookupInput): string {
  const title = input.title.trim();
  if (title.length >= 12) return title;
  return input.rawCitation?.trim() ?? title;
}

function normalizeLookupInput(
  input: ReferenceResolutionLookupInput,
): ReferenceResolutionLookupInput {
  const rawPool = [input.rawCitation, input.title].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  const inferredDoi =
    input.doi ?? rawPool.map((value) => extractDoi(value)).find(Boolean) ?? null;
  const inferredArxiv =
    input.arxivId ??
    rawPool.map((value) => extractArxivId(value)).find(Boolean) ??
    null;

  return {
    ...input,
    title: normalizeResolverTitle(input.title),
    rawCitation: input.rawCitation?.trim() ?? null,
    doi: inferredDoi,
    arxivId: inferredArxiv,
  };
}

async function enrichLookupInputFromReferenceUrl(
  input: ReferenceResolutionLookupInput,
): Promise<ReferenceResolutionLookupInput> {
  const extractedUrl = extractReferenceUrl(input.rawCitation ?? input.title);
  if (!extractedUrl || !isLikelyScholarlyUrl(extractedUrl)) {
    return input;
  }

  const fallbackDoi = extractDoiFromUrl(extractedUrl);

  const cached = await withCachedLookup(
    {
      lookupKey: extractedUrl,
      lookupType: "reference_url",
      provider: "url_meta_extract",
    },
    async () => {
      try {
        const content = await extractUrlContent(extractedUrl);
        return {
          responsePayload: JSON.stringify(content),
          resolvedEntityId: null,
          httpStatus: 200,
        };
      } catch {
        return {
          responsePayload: null,
          resolvedEntityId: null,
          httpStatus: 404,
        };
      }
    },
    CACHE_TTL.hit,
  );

  const content = cached.responsePayload
    ? parseJson<Awaited<ReturnType<typeof extractUrlContent>>>(cached.responsePayload)
    : null;

  if (!content && !fallbackDoi) {
    return input;
  }

  return normalizeLookupInput({
    ...input,
    title: shouldPreferUrlTitle(input.title, content?.title)
      ? content?.title ?? input.title
      : input.title,
    authors:
      toAuthorList(input.authors).length > 0
        ? input.authors
        : content?.authors ?? input.authors,
    year: choosePreferredYear(input.year ?? null, content?.year ?? null),
    venue: shouldPreferUrlVenue(input.venue ?? null) ? content?.siteName ?? null : input.venue,
    doi: input.doi ?? content?.doi ?? fallbackDoi ?? null,
  });
}

async function loadResolverCandidates(
  query: string,
  year: number | null,
  input: ReferenceResolutionLookupInput,
): Promise<ResolverCandidate[]> {
  const queries = buildQueryVariants(input, query);
  const lookupKey = buildLookupKey(input, queries);
  const cached = await withCachedLookup(
    {
      lookupKey,
      lookupType: "title_author_year",
      provider: "resolver_candidates",
    },
    async () => {
      const results = await Promise.all(
        queries.map(async (variant) => {
          const [providerResults, arxivResults] = await Promise.all([
            searchAllSources(variant, year),
            searchArxivTitleCandidates(variant),
          ]);
          return [...providerResults, ...arxivResults];
        }),
      );
      return {
        responsePayload: JSON.stringify(deduplicateResolverCandidates(results.flat())),
        resolvedEntityId: null,
        httpStatus: 200,
      };
    },
    CACHE_TTL.hit,
  );

  if (!cached.responsePayload) return [];

  try {
    const parsed = JSON.parse(cached.responsePayload) as ResolverCandidate[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function resolveReferenceByExactIdentifier(
  input: ReferenceResolutionLookupInput,
): Promise<OnlineResolutionResult | null> {
  if (input.doi) {
    const normalizedDoi = normalizeIdentifier("doi", input.doi);
    const cached = await withCachedLookup(
      {
        lookupKey: normalizedDoi,
        lookupType: "doi",
        provider: "doi_exact_external",
      },
      async () => {
        const metadata = await fetchDoiMetadata(normalizedDoi);
        return {
          responsePayload: metadata ? JSON.stringify(metadata) : null,
          resolvedEntityId: null,
          httpStatus: metadata ? 200 : 404,
        };
      },
      CACHE_TTL.hit,
    );

    if (cached.responsePayload) {
      const metadata = parseJson<Awaited<ReturnType<typeof fetchDoiMetadata>>>(
        cached.responsePayload,
      );
      if (metadata) {
        return {
          candidate: {
            semanticScholarId: `doi:${normalizedDoi}`,
            title: metadata.title,
            abstract: metadata.abstract,
            authors: metadata.authors,
            year: metadata.year,
            venue: metadata.venue,
            doi: normalizedDoi,
            arxivId: null,
            openReviewId: null,
            externalUrl: `https://doi.org/${normalizedDoi}`,
            citationCount: null,
            openAccessPdfUrl: metadata.openAccessPdfUrl,
          },
          resolutionMethod: "doi_exact",
          resolutionConfidence: 1.0,
          matchedFieldCount: 1,
          matchedIdentifiers: [{ type: "doi", value: normalizedDoi }],
          evidence: ["doi_exact_external"],
        };
      }
    }
  }

  if (input.arxivId) {
    const normalizedArxiv = normalizeIdentifier("arxiv", input.arxivId);
    const cached = await withCachedLookup(
      {
        lookupKey: normalizedArxiv,
        lookupType: "arxiv_id",
        provider: "arxiv_exact_external",
      },
      async () => {
        try {
          const metadata = await fetchArxivMetadata(normalizedArxiv);
          return {
            responsePayload: JSON.stringify(metadata),
            resolvedEntityId: null,
            httpStatus: 200,
          };
        } catch {
          return {
            responsePayload: null,
            resolvedEntityId: null,
            httpStatus: 404,
          };
        }
      },
      CACHE_TTL.hit,
    );

    if (cached.responsePayload) {
      const metadata = parseJson<Awaited<ReturnType<typeof fetchArxivMetadata>>>(
        cached.responsePayload,
      );
      if (metadata) {
        return {
          candidate: {
            semanticScholarId: `arxiv:${normalizedArxiv}`,
            title: metadata.title,
            abstract: metadata.abstract,
            authors: metadata.authors,
            year: metadata.year,
            venue:
              metadata.categories.length > 0
                ? `arXiv ${metadata.categories[0]}`
                : "arXiv",
            doi: null,
            arxivId: normalizedArxiv,
            openReviewId: null,
            externalUrl: `https://arxiv.org/abs/${normalizedArxiv}`,
            citationCount: null,
            openAccessPdfUrl: metadata.pdfUrl,
          },
          resolutionMethod: "arxiv_exact",
          resolutionConfidence: 1.0,
          matchedFieldCount: 1,
          matchedIdentifiers: [{ type: "arxiv", value: normalizedArxiv }],
          evidence: ["arxiv_exact_external"],
        };
      }
    }
  }

  return null;
}

function buildLookupKey(
  input: ReferenceResolutionLookupInput,
  queries: string[],
): string {
  const authorSurname = firstAuthorSurname(toAuthorList(input.authors)) ?? "na";
  return createHash("sha1")
    .update(
      JSON.stringify({
        queries: queries.map((query) => normalizeTitle(query)),
        year: input.year ?? null,
        authorSurname,
      }),
    )
    .digest("hex");
}

function buildQueryVariants(
  input: ReferenceResolutionLookupInput,
  query: string,
): string[] {
  const candidates = [
    query,
    query.split(":")[0]?.trim() ?? null,
    input.title.split(":")[0]?.trim() ?? null,
    query.split(".")[0]?.trim() ?? null,
  ]
    .map((value) => normalizeQueryVariant(value))
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates)).slice(0, 4);
}

function normalizeQueryVariant(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length >= 6 ? normalized : null;
}

function extractReferenceUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalized = value
    .replace(/\bhttps?\s*:\s*\/\s*\//gi, (match) =>
      match.toLowerCase().startsWith("https") ? "https://" : "http://",
    )
    .replace(/\bwww\s*\.\s*/gi, "www.");

  const match = normalized.match(URL_REGEX);
  if (!match?.[0]) return null;

  const collapsed = match[0].replace(/\s+/g, "");
  const trimmed = collapsed.replace(/[),.;]+$/, "");
  if (trimmed.startsWith("www.")) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function isLikelyScholarlyUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return SCHOLARLY_HOST_REGEX.test(hostname);
  } catch {
    return false;
  }
}

function shouldPreferUrlTitle(
  currentTitle: string,
  urlTitle: string | undefined,
): boolean {
  if (!urlTitle?.trim()) return false;
  const trimmedCurrent = currentTitle.trim();
  if (!trimmedCurrent) return true;
  if (isSuspiciousExtractedTitle(trimmedCurrent)) return true;
  return false;
}

function isSuspiciousExtractedTitle(title: string): boolean {
  return (
    /\b[0-9a-f]{16,}-abstract\b/i.test(title) ||
    /\.html?$/i.test(title) ||
    /^https?:\/\//i.test(title)
  );
}

function shouldPreferUrlVenue(venue: string | null): boolean {
  if (!venue) return true;
  return venue.trim().toLowerCase() === "html";
}

function choosePreferredYear(
  currentYear: number | null,
  fallbackYear: number | null,
): number | null {
  if (!currentYear) return fallbackYear;
  if (currentYear < 1950 || currentYear > new Date().getUTCFullYear() + 1) {
    return fallbackYear ?? currentYear;
  }
  return currentYear;
}

function parseJson<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

async function searchArxivTitleCandidates(
  query: string,
): Promise<ResolverCandidate[]> {
  try {
    const results = await searchArxivByTitle(query, 5);
    return results.map((result) => ({
      semanticScholarId: `arxiv:${result.arxivId}`,
      title: result.title,
      abstract: result.abstract,
      authors: result.authors,
      year: result.year,
      venue: result.categories.length > 0 ? `arXiv ${result.categories[0]}` : "arXiv",
      doi: null,
      arxivId: result.arxivId,
      openReviewId: null,
      externalUrl: `https://arxiv.org/abs/${result.arxivId}`,
      citationCount: null,
      openAccessPdfUrl: result.pdfUrl,
      source: "arxiv",
    }));
  } catch {
    return [];
  }
}

function deduplicateResolverCandidates(
  candidates: ResolverCandidate[],
): ResolverCandidate[] {
  const seen = new Map<string, ResolverCandidate>();

  for (const candidate of candidates) {
    const key = candidate.doi
      ? `doi:${candidate.doi.toLowerCase()}`
      : candidate.arxivId
        ? `arxiv:${candidate.arxivId.toLowerCase()}`
        : `title:${normalizeTitle(candidate.title)}`;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, candidate);
      continue;
    }

    if ((candidate.citationCount ?? -1) > (existing.citationCount ?? -1)) {
      seen.set(key, candidate);
    }
  }

  return Array.from(seen.values());
}

function normalizeResolverTitle(title: string): string {
  const trimmed = title.trim().replace(/^\(?\d{4}[a-z]?\)?[.:]\s*/i, "");
  return stripAuthorLead(trimmed);
}

function stripAuthorLead(title: string): string {
  const segments = title
    .split(/\.\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) return title;

  const [lead, ...rest] = segments;
  if (!looksLikeAuthorLead(lead)) return title;

  const remainder = rest.join(". ").trim();
  return remainder.length > 8 ? remainder : title;
}

function looksLikeAuthorLead(value: string): boolean {
  const commaCount = (value.match(/,/g) ?? []).length;
  if (commaCount < 2 && !/\bet al\b/i.test(value) && !/\sand\s/i.test(value)) {
    return false;
  }

  const tokens = value
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z]+|[^A-Za-z.'-]+$/g, ""))
    .filter(Boolean);
  if (tokens.length < 4) return false;

  const capitalizedRatio =
    tokens.filter((token) => /^[A-Z][A-Za-z.'-]*$/.test(token)).length /
    Math.max(tokens.length, 1);
  return capitalizedRatio >= 0.45;
}

function extractDoi(value: string): string | null {
  const match = value.match(DOI_REGEX);
  return match?.[0]?.replace(/[).,;]+$/, "") ?? null;
}

function extractArxivId(value: string): string | null {
  const match = value.match(ARXIV_REGEX);
  return match?.[1] ? normalizeIdentifier("arxiv", match[1]) : null;
}

function isLikelyNonScholarlyWebReference(
  input: ReferenceResolutionLookupInput,
): boolean {
  if (input.doi || input.arxivId) return false;
  const rawCitation = input.rawCitation ?? "";
  const title = input.title ?? "";
  return (
    NON_SCHOLARLY_URL_REGEX.test(rawCitation) ||
    NON_SCHOLARLY_URL_REGEX.test(title)
  );
}

function toAuthorList(
  authors: string[] | string | null | undefined,
): string[] {
  if (Array.isArray(authors)) {
    return authors.map((author) => author.trim()).filter(Boolean);
  }

  if (typeof authors !== "string" || !authors.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(authors);
    if (Array.isArray(parsed)) {
      return parsed
        .map((author) => String(author).trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to delimiter-based parsing.
  }

  return authors
    .split(/[;,]/)
    .map((author) => author.trim())
    .filter(Boolean);
}

function firstAuthorSurname(authors: string[]): string | null {
  return extractSurname(authors[0] ?? null);
}

function computeAuthorScore(referenceAuthors: string[], candidateAuthors: string[]): number {
  if (referenceAuthors.length === 0 || candidateAuthors.length === 0) return 0;

  const referenceSurnames = uniqueSurnames(referenceAuthors);
  const candidateSurnames = uniqueSurnames(candidateAuthors);
  if (referenceSurnames.length === 0 || candidateSurnames.length === 0) return 0;

  const candidateSet = new Set(candidateSurnames);
  let overlap = 0;
  for (const surname of referenceSurnames) {
    if (candidateSet.has(surname)) overlap += 1;
  }

  const overlapScore = overlap / Math.max(1, Math.min(referenceSurnames.length, 3));
  const firstAuthorMatch =
    referenceSurnames[0] && referenceSurnames[0] === candidateSurnames[0];

  return clamp01(Math.max(overlapScore, firstAuthorMatch ? 1 : 0));
}

function computeYearScore(referenceYear: number | null, candidateYear: number | null): number {
  if (!referenceYear || !candidateYear) return 0;
  const diff = Math.abs(referenceYear - candidateYear);
  if (diff === 0) return 1;
  if (diff === 1) return 0.5;
  if (diff === 2) return 0.2;
  return 0;
}

function computeVenueScore(referenceVenue: string | null, candidateVenue: string | null): number {
  if (!referenceVenue || !candidateVenue) return 0;
  const normalizedReference = normalizeTitle(referenceVenue);
  const normalizedCandidate = normalizeTitle(candidateVenue);
  if (!normalizedReference || !normalizedCandidate) return 0;
  if (normalizedReference === normalizedCandidate) return 1;
  if (
    normalizedReference.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedReference)
  ) {
    return 0.85;
  }
  return titleSimilarity(normalizedReference, normalizedCandidate);
}

function uniqueSurnames(authors: string[]): string[] {
  return Array.from(
    new Set(
      authors
        .map((author) => extractSurname(author))
        .filter((author): author is string => Boolean(author)),
    ),
  );
}

function extractSurname(author: string | null): string | null {
  if (!author) return null;
  const trimmed = author.trim();
  if (!trimmed) return null;

  const commaSeparated = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaSeparated.length >= 2) {
    const surname = commaSeparated[0]
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return surname || null;
  }

  const normalized = author
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  const parts = normalized.split(" ");
  if (parts.length === 1) return parts[0];

  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const last = parts[parts.length - 1];
  if (suffixes.has(last) && parts.length > 1) {
    return parts[parts.length - 2];
  }

  return last;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
