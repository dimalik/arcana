/**
 * Semantic Scholar Graph API client for citation chain traversal.
 * Uses the /references and /citations endpoints to follow citation chains.
 * Falls back to OpenAlex for reverse citation lookup when S2 key not available.
 */

import {
  fetchWithRetry,
  parseS2Paper,
  getS2Headers,
  type S2Result,
} from "@/lib/import/semantic-scholar";

const S2_BASE = "https://api.semanticscholar.org/graph/v1/paper";
const S2_FIELDS =
  "title,authors,year,venue,doi,externalIds,openAccessPdf,citationCount";

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

/**
 * Resolve a paper identifier to an OpenAlex work ID.
 * Handles DOI URLs, OpenAlex URLs, and plain DOIs.
 */
async function resolveToOpenAlexId(paperId: string): Promise<string | null> {
  // Already an OpenAlex ID
  if (paperId.startsWith("https://openalex.org/")) return paperId;

  // DOI URL or plain DOI — look up via OpenAlex
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

/**
 * Get papers referenced by the given paper (outbound references).
 * Tries S2 first, falls back to OpenAlex.
 */
export async function getReferencesForPaper(
  paperId: string
): Promise<S2Result[]> {
  // Try Semantic Scholar graph API
  const s2Headers = getS2Headers();
  if (s2Headers && paperId.startsWith("s2:")) {
    const rawId = paperId.replace("s2:", "");
    const url = `${S2_BASE}/${rawId}/references?fields=${S2_FIELDS}&limit=500`;
    const res = await fetchWithRetry(url, "s2", 1100, s2Headers);
    if (res) {
      const data = await res.json();
      const edges: S2GraphEdge[] = data.data || [];
      return edges
        .filter((e) => e.citedPaper?.paperId && e.citedPaper?.title)
        .map((e) => parseS2Paper(e.citedPaper!));
    }
  }

  // Resolve to OpenAlex ID and get references
  const oaId = await resolveToOpenAlexId(paperId);
  if (oaId) {
    return getOpenAlexReferences(oaId);
  }

  return [];
}

/**
 * Get papers that cite the given paper (inbound citations).
 * Tries S2 first, falls back to OpenAlex.
 */
export async function getCitationsForPaper(
  paperId: string
): Promise<S2Result[]> {
  // Try Semantic Scholar graph API
  const s2Headers = getS2Headers();
  if (s2Headers && paperId.startsWith("s2:")) {
    const rawId = paperId.replace("s2:", "");
    const url = `${S2_BASE}/${rawId}/citations?fields=${S2_FIELDS}&limit=500`;
    const res = await fetchWithRetry(url, "s2", 1100, s2Headers);
    if (res) {
      const data = await res.json();
      const edges: S2GraphEdge[] = data.data || [];
      return edges
        .filter((e) => e.citingPaper?.paperId && e.citingPaper?.title)
        .map((e) => parseS2Paper(e.citingPaper!));
    }
  }

  // Resolve to OpenAlex ID and get citations
  const oaId = await resolveToOpenAlexId(paperId);
  if (oaId) {
    return getOpenAlexCitations(oaId);
  }

  return [];
}

// ── OpenAlex fallbacks ──────────────────────────────────────────────

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

  // Fetch details in batches of 50
  const results: S2Result[] = [];
  for (let i = 0; i < refIds.length; i += 50) {
    const batch = refIds.slice(i, i + 50);
    const filter = batch.map((id) => id.replace("https://openalex.org/", "")).join("|");
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
  const url = `${OPENALEX_BASE}?filter=cites:${oaId}&select=${OPENALEX_SELECT}&per_page=200&sort=cited_by_count:desc`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return [];

  const data = await res.json();
  const works: OpenAlexWork[] = data.results || [];
  return works.filter((w) => w.title).map(parseOpenAlexWork);
}
