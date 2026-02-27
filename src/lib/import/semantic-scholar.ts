/**
 * Academic paper metadata enrichment via:
 *   1. OpenAlex (primary) — free, 1000 title searches/day, unlimited DOI lookups
 *   2. Semantic Scholar (secondary) — needs S2_API_KEY env var, 1 req/s
 *   3. CrossRef (tertiary) — free polite pool with mailto param
 *
 * The DB field `semanticScholarId` stores whichever source ID found the match.
 */

import { titleSimilarity } from "@/lib/references/match";

const OPENALEX_BASE = "https://api.openalex.org/works";
const OPENALEX_SELECT =
  "id,doi,title,display_name,publication_year,authorships,primary_location,open_access,ids,cited_by_count,indexed_in";

const S2_BASE = "https://api.semanticscholar.org/graph/v1/paper";
const S2_FIELDS =
  "title,authors,year,venue,externalIds,openAccessPdf,citationCount";

const CROSSREF_BASE = "https://api.crossref.org/works";
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || "paperfinder@localhost";

// ── Public types ────────────────────────────────────────────────────

export interface S2Result {
  semanticScholarId: string; // source-specific ID (OpenAlex URL, S2 paperId, or crossref:DOI)
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  openReviewId: string | null;
  externalUrl: string;
  citationCount: number | null;
  openAccessPdfUrl: string | null;
}

export class S2RateLimitError extends Error {
  constructor() {
    super("Enrichment API rate limit exceeded");
    this.name = "S2RateLimitError";
  }
}

// ── Rate limiting (per-source) ──────────────────────────────────────

const lastRequest: Record<string, number> = {};

async function delayForSource(source: string, minMs: number): Promise<void> {
  const now = Date.now();
  const elapsed = now - (lastRequest[source] || 0);
  if (elapsed < minMs) {
    await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
  }
  lastRequest[source] = Date.now();
}

const MAX_RETRIES = 2;

export async function fetchWithRetry(
  url: string,
  source: string,
  minDelayMs: number,
  headers?: Record<string, string>
): Promise<Response | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await delayForSource(source, minDelayMs);
    const res = await fetch(url, headers ? { headers } : undefined);

    if (res.ok) return res;

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitSec = retryAfter
        ? Math.max(parseInt(retryAfter, 10), 2)
        : 3 * (attempt + 1);
      console.warn(
        `[${source}] 429 rate limited, waiting ${waitSec}s (retry ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      continue;
    }

    console.error(`[${source}] ${res.status} ${res.statusText} — ${url}`);
    return null;
  }

  // Only throw if this was the last source in the chain — callers handle null gracefully
  return null;
}

// ── OpenAlex ────────────────────────────────────────────────────────

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  authorships?: { author: { display_name: string } }[];
  primary_location?: {
    source?: { display_name?: string } | null;
    raw_source_name?: string | null;
  } | null;
  open_access?: {
    oa_url?: string | null;
    is_oa?: boolean;
  } | null;
  ids?: Record<string, string> | null;
  cited_by_count?: number;
  indexed_in?: string[];
}

function extractArxivIdFromDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  const match = doi.match(/10\.48550\/arxiv\.(.+)/i);
  return match ? match[1] : null;
}

function cleanDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  return doi.replace(/^https?:\/\/doi\.org\//i, "");
}

function parseOpenAlexWork(work: OpenAlexWork): S2Result {
  const rawDoi = cleanDoi(work.doi);
  const arxivId = extractArxivIdFromDoi(rawDoi);
  const venue =
    work.primary_location?.source?.display_name ||
    work.primary_location?.raw_source_name ||
    null;

  let externalUrl = work.id;
  if (rawDoi && !arxivId) externalUrl = `https://doi.org/${rawDoi}`;
  else if (arxivId) externalUrl = `https://arxiv.org/abs/${arxivId}`;

  return {
    semanticScholarId: work.id,
    title: work.title || work.display_name || "",
    authors: (work.authorships || []).map((a) => a.author.display_name),
    year: work.publication_year ?? null,
    venue,
    doi: arxivId ? null : rawDoi,
    arxivId,
    openReviewId: null,
    externalUrl,
    citationCount: work.cited_by_count ?? null,
    openAccessPdfUrl: work.open_access?.oa_url || null,
  };
}

async function searchOpenAlex(
  title: string,
  year: number | null | undefined
): Promise<S2Result | null> {
  const url =
    `${OPENALEX_BASE}?filter=title.search:${encodeURIComponent(title)}` +
    `&select=${OPENALEX_SELECT}&per_page=5`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return null;

  const data = await res.json();
  const works: OpenAlexWork[] = data.results || [];
  return pickBest(title, year, works.map(parseOpenAlexWork));
}

// ── Semantic Scholar ────────────────────────────────────────────────

interface S2PaperRaw {
  paperId: string;
  title: string;
  authors?: { name: string }[];
  year?: number;
  venue?: string;
  doi?: string;
  externalIds?: Record<string, string>;
  openAccessPdf?: { url: string } | null;
  citationCount?: number;
}

export function parseS2Paper(raw: S2PaperRaw): S2Result {
  const externalIds = raw.externalIds || {};
  const arxivId = externalIds.ArXiv || null;
  const doi = raw.doi || externalIds.DOI || null;
  const openReviewId = externalIds.OpenReview || null;

  let externalUrl = `https://www.semanticscholar.org/paper/${raw.paperId}`;
  if (doi) externalUrl = `https://doi.org/${doi}`;
  else if (arxivId) externalUrl = `https://arxiv.org/abs/${arxivId}`;

  return {
    semanticScholarId: `s2:${raw.paperId}`,
    title: raw.title,
    authors: (raw.authors || []).map((a) => a.name),
    year: raw.year ?? null,
    venue: raw.venue || null,
    doi,
    arxivId,
    openReviewId,
    externalUrl,
    citationCount: raw.citationCount ?? null,
    openAccessPdfUrl: raw.openAccessPdf?.url || null,
  };
}

export function getS2Headers(): Record<string, string> | undefined {
  const apiKey = process.env.S2_API_KEY;
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

async function searchS2(
  title: string,
  year: number | null | undefined
): Promise<S2Result | null> {
  const headers = getS2Headers();
  if (!headers) return null; // skip S2 if no API key

  const cleaned = title.replace(/-/g, " ").replace(/\s+/g, " ").trim();

  // Try /match endpoint first
  const matchUrl = `${S2_BASE}/search/match?query=${encodeURIComponent(cleaned)}&fields=${S2_FIELDS}`;
  const matchRes = await fetchWithRetry(matchUrl, "s2", 1100, headers);

  if (matchRes) {
    const matchData = await matchRes.json();
    const paper: S2PaperRaw | undefined = matchData.data?.[0];
    if (paper?.title) {
      const score = titleSimilarity(title, paper.title);
      if (score >= 0.7) return parseS2Paper(paper);
    }
  }

  // Fallback to keyword search
  const searchUrl = `${S2_BASE}/search?query=${encodeURIComponent(cleaned)}&fields=${S2_FIELDS}&limit=5`;
  const searchRes = await fetchWithRetry(searchUrl, "s2", 1100, headers);
  if (!searchRes) return null;

  const data = await searchRes.json();
  const papers: S2PaperRaw[] = data.data || [];
  return pickBest(title, year, papers.map(parseS2Paper));
}

// ── CrossRef ────────────────────────────────────────────────────────

interface CrossRefItem {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string }[];
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  "is-referenced-by-count"?: number;
}

function parseCrossRefItem(item: CrossRefItem): S2Result {
  const doi = item.DOI || null;
  const title = item.title?.[0] || "";
  const authors = (item.author || [])
    .map((a) => [a.given, a.family].filter(Boolean).join(" "))
    .filter(Boolean);
  const year = item.issued?.["date-parts"]?.[0]?.[0] ?? null;
  const venue = item["container-title"]?.[0] || null;

  return {
    semanticScholarId: doi ? `crossref:${doi}` : `crossref:${title}`,
    title,
    authors,
    year,
    venue,
    doi,
    arxivId: null,
    openReviewId: null,
    externalUrl: doi ? `https://doi.org/${doi}` : "",
    citationCount: item["is-referenced-by-count"] ?? null,
    openAccessPdfUrl: null,
  };
}

async function searchCrossRef(
  title: string,
  year: number | null | undefined
): Promise<S2Result | null> {
  const url =
    `${CROSSREF_BASE}?query.bibliographic=${encodeURIComponent(title)}` +
    `&rows=5&mailto=${encodeURIComponent(CROSSREF_MAILTO)}`;
  const res = await fetchWithRetry(url, "crossref", 150);
  if (!res) return null;

  const data = await res.json();
  const items: CrossRefItem[] = data.message?.items || [];
  return pickBest(title, year, items.map(parseCrossRefItem));
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Search by title across all sources: OpenAlex → Semantic Scholar → CrossRef.
 * Returns the first match found. Throws S2RateLimitError only if ALL sources 429.
 */
export async function searchByTitle(
  title: string,
  year?: number | null
): Promise<S2Result | null> {
  // 1. OpenAlex (fast, generous limits)
  const oaResult = await searchOpenAlex(title, year);
  if (oaResult) return oaResult;

  // 2. Semantic Scholar (if API key configured)
  const s2Result = await searchS2(title, year);
  if (s2Result) return s2Result;

  // 3. CrossRef (fallback)
  const crResult = await searchCrossRef(title, year);
  if (crResult) return crResult;

  return null;
}

/**
 * Fetch a paper by its OpenAlex ID (or DOI via OpenAlex).
 */
export async function fetchById(id: string): Promise<S2Result | null> {
  const url = `${OPENALEX_BASE}/${encodeURIComponent(id)}?select=${OPENALEX_SELECT}`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return null;

  const work: OpenAlexWork = await res.json();
  return parseOpenAlexWork(work);
}

// ── Shared helpers ──────────────────────────────────────────────────

function pickBest(
  title: string,
  year: number | null | undefined,
  candidates: S2Result[]
): S2Result | null {
  let bestResult: S2Result | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (!candidate.title) continue;

    let score = titleSimilarity(title, candidate.title);

    if (year && candidate.year && Math.abs(candidate.year - year) <= 1) {
      score += 0.05;
    }

    if (score > bestScore) {
      bestScore = score;
      bestResult = candidate;
    }
  }

  if (bestScore < 0.7) return null;
  return bestResult;
}
