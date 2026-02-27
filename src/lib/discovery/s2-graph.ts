/**
 * Citation graph traversal via Semantic Scholar (primary) and OpenAlex (fallback).
 *
 * S2 has much better reference/citation coverage than OpenAlex, especially for
 * recent papers, so we always try S2 first. OpenAlex is used as a fallback when
 * S2 has no API key or returns no results.
 */

import {
  fetchWithRetry,
  parseS2Paper,
  getS2Headers,
  type S2Result,
} from "@/lib/import/semantic-scholar";

const S2_BASE = "https://api.semanticscholar.org/graph/v1/paper";
const S2_FIELDS =
  "title,authors,year,venue,externalIds,openAccessPdf,citationCount";

const OPENALEX_BASE = "https://api.openalex.org/works";
const OPENALEX_SELECT =
  "id,doi,title,display_name,publication_year,authorships,primary_location,open_access,ids,cited_by_count";

interface S2GraphEdge {
  citedPaper?: S2PaperRaw;
  citingPaper?: S2PaperRaw;
}

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

// ── S2 paper ID resolution ──────────────────────────────────────────

/**
 * Resolve any paper identifier to an S2 paper ID.
 * Accepts: s2:<id>, DOI URL, OpenAlex URL, arXiv ID, or plain DOI.
 */
async function resolveToS2Id(paperId: string): Promise<string | null> {
  const s2Headers = getS2Headers();
  if (!s2Headers) return null;

  // Already an S2 ID
  if (paperId.startsWith("s2:")) return paperId.replace("s2:", "");

  // Try DOI lookup via S2
  let doi: string | null = null;
  if (paperId.startsWith("https://doi.org/")) {
    doi = paperId.replace("https://doi.org/", "");
  } else if (paperId.match(/^10\.\d{4,}/)) {
    doi = paperId;
  }

  if (doi) {
    const url = `${S2_BASE}/DOI:${encodeURIComponent(doi)}?fields=paperId`;
    const res = await fetchWithRetry(url, "s2", 1100, s2Headers);
    if (res) {
      const data = await res.json();
      if (data.paperId) return data.paperId;
    }
  }

  // Try arXiv ID lookup
  if (paperId.match(/^\d{4}\.\d{4,}/)) {
    const url = `${S2_BASE}/ARXIV:${paperId}?fields=paperId`;
    const res = await fetchWithRetry(url, "s2", 1100, s2Headers);
    if (res) {
      const data = await res.json();
      if (data.paperId) return data.paperId;
    }
  }

  // OpenAlex ID — extract DOI from OpenAlex and resolve via S2
  if (paperId.startsWith("https://openalex.org/")) {
    const oaUrl = `${OPENALEX_BASE}/${encodeURIComponent(paperId)}?select=doi,title`;
    const oaRes = await fetchWithRetry(oaUrl, "openalex", 200);
    if (oaRes) {
      const oaData = await oaRes.json();
      const oaDoi = oaData.doi?.replace(/^https?:\/\/doi\.org\//i, "");
      if (oaDoi) {
        const s2Url = `${S2_BASE}/DOI:${encodeURIComponent(oaDoi)}?fields=paperId`;
        const s2Res = await fetchWithRetry(s2Url, "s2", 1100, s2Headers);
        if (s2Res) {
          const s2Data = await s2Res.json();
          if (s2Data.paperId) return s2Data.paperId;
        }
      }
      // Fallback: search S2 by title
      if (oaData.title) {
        return searchS2ByTitle(oaData.title, s2Headers);
      }
    }
  }

  return null;
}

async function searchS2ByTitle(
  title: string,
  s2Headers: Record<string, string>
): Promise<string | null> {
  const cleaned = title.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  const url = `${S2_BASE}/search/match?query=${encodeURIComponent(cleaned)}&fields=paperId,title`;
  const res = await fetchWithRetry(url, "s2", 1100, s2Headers);
  if (!res) return null;
  const data = await res.json();
  const paper = data.data?.[0];
  if (paper?.paperId) return paper.paperId;
  return null;
}

// ── S2 graph API ────────────────────────────────────────────────────

async function getS2References(s2Id: string): Promise<S2Result[]> {
  const s2Headers = getS2Headers();
  if (!s2Headers) return [];

  const url = `${S2_BASE}/${s2Id}/references?fields=${S2_FIELDS}&limit=100`;
  const res = await fetchWithRetry(url, "s2", 1100, s2Headers);
  if (!res) return [];

  const data = await res.json();
  const edges: S2GraphEdge[] = data.data || [];
  return edges
    .filter((e) => e.citedPaper?.paperId && e.citedPaper?.title)
    .map((e) => parseS2Paper(e.citedPaper!));
}

async function getS2Citations(s2Id: string): Promise<S2Result[]> {
  const s2Headers = getS2Headers();
  if (!s2Headers) return [];

  const url = `${S2_BASE}/${s2Id}/citations?fields=${S2_FIELDS}&limit=100`;
  const res = await fetchWithRetry(url, "s2", 1100, s2Headers);
  if (!res) return [];

  const data = await res.json();
  const edges: S2GraphEdge[] = data.data || [];
  return edges
    .filter((e) => e.citingPaper?.paperId && e.citingPaper?.title)
    .map((e) => parseS2Paper(e.citingPaper!))
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
}

// ── OpenAlex fallbacks ──────────────────────────────────────────────

async function resolveToOpenAlexId(paperId: string): Promise<string | null> {
  if (paperId.startsWith("https://openalex.org/")) return paperId;

  let doi = paperId;
  if (paperId.startsWith("https://doi.org/")) {
    doi = paperId.replace("https://doi.org/", "");
  }

  const url = `${OPENALEX_BASE}/https://doi.org/${encodeURIComponent(doi)}?select=id`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return null;

  const data = await res.json();
  return data.id || null;
}

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  authorships?: { author: { display_name: string } }[];
  primary_location?: {
    source?: { display_name?: string } | null;
  } | null;
  open_access?: { oa_url?: string | null } | null;
  ids?: Record<string, string> | null;
  cited_by_count?: number;
}

function parseOpenAlexWork(work: OpenAlexWork): S2Result {
  const rawDoi = work.doi
    ? work.doi.replace(/^https?:\/\/doi\.org\//i, "")
    : null;
  const arxivMatch = rawDoi?.match(/10\.48550\/arxiv\.(.+)/i);
  const arxivId = arxivMatch ? arxivMatch[1] : null;
  const venue = work.primary_location?.source?.display_name || null;

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

async function getOpenAlexReferences(workId: string): Promise<S2Result[]> {
  const url = `${OPENALEX_BASE}/${encodeURIComponent(workId)}?select=referenced_works`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return [];

  const data = await res.json();
  const refIds: string[] = data.referenced_works || [];
  if (refIds.length === 0) return [];

  const results: S2Result[] = [];
  for (let i = 0; i < refIds.length; i += 50) {
    const batch = refIds.slice(i, i + 50);
    const filter = batch
      .map((id) => id.replace("https://openalex.org/", ""))
      .join("|");
    const detailUrl = `${OPENALEX_BASE}?filter=ids.openalex:${filter}&select=${OPENALEX_SELECT}&per_page=50`;
    const detailRes = await fetchWithRetry(detailUrl, "openalex", 200);
    if (!detailRes) continue;

    const detailData = await detailRes.json();
    const works: OpenAlexWork[] = detailData.results || [];
    results.push(...works.filter((w) => w.title).map(parseOpenAlexWork));
  }
  return results;
}

async function getOpenAlexCitations(workId: string): Promise<S2Result[]> {
  const oaId = workId.replace("https://openalex.org/", "");
  const url = `${OPENALEX_BASE}?filter=cites:${oaId}&select=${OPENALEX_SELECT}&per_page=100&sort=cited_by_count:desc`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return [];

  const data = await res.json();
  const works: OpenAlexWork[] = data.results || [];
  return works.filter((w) => w.title).map(parseOpenAlexWork);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get papers referenced by the given paper (outbound references).
 * Tries S2 first (better coverage), falls back to OpenAlex.
 */
export async function getReferencesForPaper(
  paperId: string
): Promise<S2Result[]> {
  // Try S2 (resolves any ID format to S2 paper ID)
  const s2Id = await resolveToS2Id(paperId);
  if (s2Id) {
    const results = await getS2References(s2Id);
    if (results.length > 0) {
      console.log(`[discovery] S2 references for ${paperId}: ${results.length}`);
      return results;
    }
  }

  // Fall back to OpenAlex
  const oaId = await resolveToOpenAlexId(paperId);
  if (oaId) {
    const results = await getOpenAlexReferences(oaId);
    console.log(`[discovery] OpenAlex references for ${paperId}: ${results.length}`);
    return results;
  }

  console.log(`[discovery] No references found for ${paperId}`);
  return [];
}

/**
 * Get papers that cite the given paper (inbound citations).
 * Tries S2 first (better coverage), falls back to OpenAlex.
 */
export async function getCitationsForPaper(
  paperId: string
): Promise<S2Result[]> {
  // Try S2
  const s2Id = await resolveToS2Id(paperId);
  if (s2Id) {
    const results = await getS2Citations(s2Id);
    if (results.length > 0) {
      console.log(`[discovery] S2 citations for ${paperId}: ${results.length}`);
      return results;
    }
  }

  // Fall back to OpenAlex
  const oaId = await resolveToOpenAlexId(paperId);
  if (oaId) {
    const results = await getOpenAlexCitations(oaId);
    console.log(`[discovery] OpenAlex citations for ${paperId}: ${results.length}`);
    return results;
  }

  console.log(`[discovery] No citations found for ${paperId}`);
  return [];
}
