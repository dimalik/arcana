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
  "title,abstract,authors,year,venue,externalIds,openAccessPdf,citationCount";

const CROSSREF_BASE = "https://api.crossref.org/works";
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || "paperfinder@localhost";

// ── Public types ────────────────────────────────────────────────────

export type SearchSource = "openalex" | "s2" | "crossref";

export interface S2Result {
  semanticScholarId: string; // source-specific ID (OpenAlex URL, S2 paperId, or crossref:DOI)
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  openReviewId: string | null;
  externalUrl: string;
  citationCount: number | null;
  openAccessPdfUrl: string | null;
  source?: SearchSource;
}

/**
 * Detect search results that are actually figure/table/supplement DOIs,
 * not real papers. Publishers like PeerJ assign DOIs to individual figures.
 */
export function isFigureOrSupplementDoi(r: { doi?: string | null; title?: string }): boolean {
  // DOI contains figure/table/supplement path segment
  if (r.doi && /\/(fig-|table-|supp-|supplement)/i.test(r.doi)) return true;
  // Title starts with "Figure N", "Table N", "Supplementary" etc. AND has a DOI (safety: don't filter DOI-less results by title alone)
  if (r.doi && r.title && /^(Figure|Table|Supplement(ary)?|Supp\.)\s+\d/i.test(r.title)) return true;
  return false;
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
    abstract: null, // OpenAlex uses inverted index format; not worth reconstructing here
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
  abstract?: string | null;
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
  const rawDoi = raw.doi || externalIds.DOI || null;
  const arxivId = externalIds.ArXiv || extractArxivIdFromDoi(rawDoi) || null;
  const doi = arxivId ? null : rawDoi;
  const openReviewId = externalIds.OpenReview || null;

  let externalUrl = `https://www.semanticscholar.org/paper/${raw.paperId}`;
  if (doi) externalUrl = `https://doi.org/${doi}`;
  else if (arxivId) externalUrl = `https://arxiv.org/abs/${arxivId}`;

  return {
    semanticScholarId: `s2:${raw.paperId}`,
    title: raw.title,
    abstract: raw.abstract || null,
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
  const arxivId = extractArxivIdFromDoi(doi);
  const title = item.title?.[0] || "";
  const authors = (item.author || [])
    .map((a) => [a.given, a.family].filter(Boolean).join(" "))
    .filter(Boolean);
  const year = item.issued?.["date-parts"]?.[0]?.[0] ?? null;
  const venue = item["container-title"]?.[0] || null;

  return {
    semanticScholarId: doi ? `crossref:${doi}` : `crossref:${title}`,
    title,
    abstract: null, // CrossRef doesn't return abstracts in search results
    authors,
    year,
    venue,
    doi: arxivId ? null : doi,
    arxivId,
    openReviewId: null,
    externalUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : doi ? `https://doi.org/${doi}` : "",
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
  if (oaResult) {
    // OpenAlex doesn't provide abstracts — try S2 to fill it in
    if (!oaResult.abstract) {
      const s2Result = await searchS2(title, year);
      if (s2Result?.abstract) {
        oaResult.abstract = s2Result.abstract;
      }
    }
    return oaResult;
  }

  // 2. Semantic Scholar (if API key configured)
  const s2Result = await searchS2(title, year);
  if (s2Result) return s2Result;

  // 3. CrossRef (fallback)
  const crResult = await searchCrossRef(title, year);
  if (crResult) {
    // CrossRef doesn't provide abstracts — try S2 to fill it in
    if (!crResult.abstract) {
      const s2Fallback = await searchS2(title, year);
      if (s2Fallback?.abstract) {
        crResult.abstract = s2Fallback.abstract;
      }
    }
    return crResult;
  }

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

// ── Multi-source search (returns all candidates) ────────────────────

async function searchOpenAlexMulti(
  query: string,
  year: number | null | undefined
): Promise<S2Result[]> {
  let url =
    `${OPENALEX_BASE}?filter=title.search:${encodeURIComponent(query)}` +
    `&select=${OPENALEX_SELECT}&per_page=5`;
  if (year) url += `&filter=publication_year:${year}`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return [];

  const data = await res.json();
  const works: OpenAlexWork[] = data.results || [];
  return works.map((w) => ({ ...parseOpenAlexWork(w), source: "openalex" as SearchSource }));
}

async function searchS2Multi(
  query: string,
): Promise<S2Result[]> {
  const headers = getS2Headers();
  if (!headers) return [];

  const cleaned = query.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  const searchUrl = `${S2_BASE}/search?query=${encodeURIComponent(cleaned)}&fields=${S2_FIELDS}&limit=5`;
  const searchRes = await fetchWithRetry(searchUrl, "s2", 1100, headers);
  if (!searchRes) return [];

  const data = await searchRes.json();
  const papers: S2PaperRaw[] = data.data || [];
  return papers.map((p) => ({ ...parseS2Paper(p), source: "s2" as SearchSource }));
}

async function searchCrossRefMulti(
  query: string,
): Promise<S2Result[]> {
  const url =
    `${CROSSREF_BASE}?query.bibliographic=${encodeURIComponent(query)}` +
    `&rows=5&mailto=${encodeURIComponent(CROSSREF_MAILTO)}`;
  const res = await fetchWithRetry(url, "crossref", 150);
  if (!res) return [];

  const data = await res.json();
  const items: CrossRefItem[] = data.message?.items || [];
  return items.map((item) => ({ ...parseCrossRefItem(item), source: "crossref" as SearchSource }));
}

function deduplicateResults(results: S2Result[]): S2Result[] {
  const seen = new Map<string, S2Result>();

  for (const r of results) {
    // Deduplicate by DOI first
    if (r.doi) {
      const key = `doi:${r.doi.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.set(key, r);
      continue;
    }
    // Then by arXiv ID
    if (r.arxivId) {
      const key = `arxiv:${r.arxivId.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.set(key, r);
      continue;
    }
    // Then by normalized title
    const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normTitle.length < 10) {
      seen.set(r.semanticScholarId, r);
      continue;
    }
    let isDupe = false;
    const existingEntries = Array.from(seen.values());
    for (const existing of existingEntries) {
      const existingNorm = existing.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (titleSimilarity(normTitle, existingNorm) > 0.85) {
        isDupe = true;
        break;
      }
    }
    if (!isDupe) {
      seen.set(r.semanticScholarId, r);
    }
  }

  return Array.from(seen.values());
}

/**
 * Search all sources in parallel and return deduplicated results sorted by citation count.
 */
export async function searchAllSources(
  query: string,
  year?: number | null
): Promise<S2Result[]> {
  const [oaResults, s2Results, crResults] = await Promise.all([
    searchOpenAlexMulti(query, year),
    searchS2Multi(query),
    searchCrossRefMulti(query),
  ]);

  const all = [...oaResults, ...s2Results, ...crResults];
  const deduped = deduplicateResults(all)
    .filter((r) => !isFigureOrSupplementDoi(r));

  // Sort by citation count descending (nulls last)
  deduped.sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1));
  return deduped;
}

// ── S2 Recommendations API (SPECTER embeddings) ────────────────────

const S2_RECS_BASE = "https://api.semanticscholar.org/recommendations/v1/papers";

/**
 * Get paper recommendations from S2's SPECTER embedding similarity API.
 * Accepts paper IDs formatted as "DOI:xxx" or "ArXiv:xxx".
 * Works without API key (public endpoint).
 */
export async function getS2Recommendations(
  paperIds: string[],
  limit = 20
): Promise<S2Result[]> {
  if (paperIds.length === 0) return [];

  const url = `${S2_RECS_BASE}/?fields=${S2_FIELDS}&limit=${limit}`;

  await delayForSource("s2", 1100);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await delayForSource("s2", 1100);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(getS2Headers() || {}),
      },
      body: JSON.stringify({ positivePaperIds: paperIds }),
    });

    if (res.ok) {
      const data = await res.json();
      const papers: S2PaperRaw[] = data.recommendedPapers || [];
      return papers.map((p) => ({ ...parseS2Paper(p), source: "s2" as SearchSource }));
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitSec = retryAfter
        ? Math.max(parseInt(retryAfter, 10), 2)
        : 3 * (attempt + 1);
      console.warn(
        `[s2-recs] 429 rate limited, waiting ${waitSec}s (retry ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      continue;
    }

    console.error(`[s2-recs] ${res.status} ${res.statusText}`);
    return [];
  }

  return [];
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
