import { prisma } from "@/lib/prisma";
import { getS2Recommendations, searchAllSources, type S2Result } from "@/lib/import/semantic-scholar";
import { searchArxivCategories } from "./arxiv-search";
import { extractInterests, type UserInterests } from "./interests";


export interface RecommendedPaper {
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string;
  citationCount: number | null;
  openAccessPdfUrl: string | null;
  source: string; // "openalex" | "s2" | "crossref" | "arxiv"
  matchReason?: string; // the tag or arXiv category that matched
}

export interface RecommendationsCache {
  latest: RecommendedPaper[];
  recommended: RecommendedPaper[];
  fetchedAt: string; // ISO date string
}

const CACHE_KEY = "recommendations_cache_v3";

function isCacheFresh(cache: RecommendationsCache): boolean {
  const fetchedDate = new Date(cache.fetchedAt).toDateString();
  const today = new Date().toDateString();
  return fetchedDate === today;
}

function s2ResultToRecommended(r: S2Result, matchReason: string): RecommendedPaper {
  return {
    title: r.title,
    abstract: r.abstract,
    authors: r.authors,
    year: r.year,
    doi: r.doi,
    arxivId: r.arxivId,
    externalUrl: r.externalUrl,
    citationCount: r.citationCount,
    openAccessPdfUrl: r.openAccessPdfUrl,
    source: r.source || "openalex",
    matchReason,
  };
}

/** Deduplicate by DOI, arXiv ID, or normalized title */
function deduplicateRecommendations(
  papers: RecommendedPaper[]
): RecommendedPaper[] {
  const seen = new Set<string>();
  const result: RecommendedPaper[] = [];

  for (const p of papers) {
    if (p.doi) {
      const key = `doi:${p.doi.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    } else if (p.arxivId) {
      const key = `arxiv:${p.arxivId.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    } else {
      const normTitle = p.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normTitle.length < 10) {
        result.push(p);
        continue;
      }
      if (seen.has(normTitle)) continue;
      seen.add(normTitle);
    }
    result.push(p);
  }

  return result;
}

/** Filter out papers already in the user's library (by DOI, arXiv ID, or title) */
async function excludeLibraryPapers(
  papers: RecommendedPaper[],
  userId: string
): Promise<RecommendedPaper[]> {
  if (papers.length === 0) return papers;

  const dois = papers.map((p) => p.doi).filter(Boolean) as string[];
  const arxivIds = papers.map((p) => p.arxivId).filter(Boolean) as string[];
  const titles = papers.map((p) => p.title).filter(Boolean);

  const conditions = [];
  if (dois.length > 0) conditions.push({ doi: { in: dois } });
  if (arxivIds.length > 0) conditions.push({ arxivId: { in: arxivIds } });
  if (titles.length > 0) conditions.push({ title: { in: titles } });

  const existing = await prisma.paper.findMany({
    where: { userId, OR: conditions },
    select: { doi: true, arxivId: true, title: true },
  });

  const existingDois = new Set(existing.map((p) => p.doi?.toLowerCase()).filter(Boolean));
  const existingArxivIds = new Set(existing.map((p) => p.arxivId?.toLowerCase()).filter(Boolean));
  const existingTitles = new Set(
    existing.map((p) => p.title.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((t) => t.length >= 10)
  );

  return papers.filter((p) => {
    if (p.doi && existingDois.has(p.doi.toLowerCase())) return false;
    if (p.arxivId && existingArxivIds.has(p.arxivId.toLowerCase())) return false;
    const normTitle = p.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normTitle.length >= 10 && existingTitles.has(normTitle)) return false;
    return true;
  });
}

// ── Signal fetchers ─────────────────────────────────────────────────

/** Signal 1: S2 SPECTER embedding recommendations from engaged paper IDs */
async function fetchS2Recommendations(
  interests: UserInterests
): Promise<RecommendedPaper[]> {
  if (interests.paperIds.length === 0) return [];

  const ids = interests.paperIds.map((p) => p.s2Id);
  try {
    const results = await getS2Recommendations(ids);
    return results.map((r) => s2ResultToRecommended(r, "Based on your library"));
  } catch (err) {
    console.warn("[recommendations] S2 recommendations failed:", err);
    return [];
  }
}

/** Signal 2: ArXiv category search for recent papers */
async function fetchArxivLatest(
  interests: UserInterests
): Promise<RecommendedPaper[]> {
  if (interests.arxivCategories.length === 0) return [];

  try {
    return await searchArxivCategories(interests.arxivCategories, 5);
  } catch (err) {
    console.warn("[recommendations] arXiv category search failed:", err);
    return [];
  }
}

/** Signal 3 (fallback): Keyword search via searchAllSources — only if S2 recs insufficient */
async function fetchKeywordFallback(
  interests: UserInterests
): Promise<RecommendedPaper[]> {
  const topQueries = interests.contentQueries.slice(0, 3);
  if (topQueries.length === 0) return [];

  const recentYear = interests.newestYear ? interests.newestYear - 1 : null;

  const formatMatchReason = (title: string): string => {
    if (title.length <= 50) return `Similar to: ${title}`;
    return `Similar to: ${title.slice(0, 50).replace(/\s\S*$/, "")}...`;
  };

  const searches = topQueries.map((cq) =>
    searchAllSources(cq.query, recentYear)
      .then((results) =>
        results.map((r) => s2ResultToRecommended(r, formatMatchReason(cq.sourcePaperTitle)))
      )
      .catch((err) => {
        console.warn(`[recommendations] keyword search failed for "${cq.query}":`, err);
        return [] as RecommendedPaper[];
      })
  );

  const results = await Promise.all(searches);
  return results.flat();
}

// ── Dedup helper for cross-section filtering ────────────────────────

/** Build a set of identity keys from a paper list */
function buildPaperKeySet(papers: RecommendedPaper[]): Set<string> {
  const keys = new Set<string>();
  for (const p of papers) {
    if (p.doi) keys.add(`doi:${p.doi.toLowerCase()}`);
    if (p.arxivId) keys.add(`arxiv:${p.arxivId.toLowerCase()}`);
    const norm = p.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length >= 10) keys.add(`title:${norm}`);
  }
  return keys;
}

/** Remove from `papers` anything already in `existingKeys` */
function crossSectionDedup(
  papers: RecommendedPaper[],
  existingKeys: Set<string>
): RecommendedPaper[] {
  return papers.filter((p) => {
    if (p.doi && existingKeys.has(`doi:${p.doi.toLowerCase()}`)) return false;
    if (p.arxivId && existingKeys.has(`arxiv:${p.arxivId.toLowerCase()}`)) return false;
    const norm = p.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length >= 10 && existingKeys.has(`title:${norm}`)) return false;
    return true;
  });
}

/**
 * Tag-scoped recommendations: uses S2 SPECTER for "Recommended" and
 * keyword searches from tagged paper titles for "Latest" (sorted by year).
 * Skips arXiv category browsing since broad categories are too noisy
 * for a focused tag filter like "efficient optimization".
 */
async function fetchTagScopedRecommendations(
  tagIds: string[],
  userId: string
): Promise<RecommendationsCache> {
  const interests = await extractInterests(userId, tagIds);

  const hasSignals =
    interests.paperIds.length > 0 ||
    interests.contentQueries.length > 0;

  if (!hasSignals) {
    return { latest: [], recommended: [], fetchedAt: new Date().toISOString() };
  }

  // S2 SPECTER recs (high quality, topic-specific) → Recommended
  // Keyword searches from tagged paper titles → Latest (sorted by recency)
  const [s2Recs, keywordResults] = await Promise.all([
    fetchS2Recommendations(interests),
    fetchKeywordFallback(interests),
  ]);

  // Latest: keyword results sorted by year (most recent first)
  const byYear = [...keywordResults].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  let latest = deduplicateRecommendations(byYear).slice(0, 10);

  // Recommended: S2 SPECTER order, then remaining keyword results by citations
  const latestKeys = buildPaperKeySet(latest);
  const remainingKeyword = crossSectionDedup(keywordResults, latestKeys);
  remainingKeyword.sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1));
  let recommended = deduplicateRecommendations([...s2Recs, ...remainingKeyword]);
  recommended = crossSectionDedup(recommended, latestKeys).slice(0, 15);

  [latest, recommended] = await Promise.all([
    excludeLibraryPapers(latest, userId),
    excludeLibraryPapers(recommended, userId),
  ]);

  return { latest, recommended, fetchedAt: new Date().toISOString() };
}

/**
 * Get recommended papers using multi-signal pipeline:
 * 1. S2 Recommendations (SPECTER embeddings) → Recommended section
 * 2. ArXiv category search → Latest section
 * 3. Keyword fallback (only if S2 recs < 5) → Recommended section
 *
 * When tagIds are provided, scopes recommendations to those tags.
 * Uses 24h cache in Setting table (unfiltered only).
 */
export async function getRecommendations(
  forceRefresh = false,
  userId?: string,
  tagIds?: string[]
): Promise<RecommendationsCache> {
  // Tag-scoped: always live (no cache), scoped to tag interests
  if (tagIds && tagIds.length > 0) {
    return fetchTagScopedRecommendations(tagIds, userId!);
  }

  // Check cache (unfiltered only)
  if (!forceRefresh) {
    const cached = await prisma.setting.findUnique({
      where: { key: CACHE_KEY },
    });
    if (cached) {
      try {
        const data = JSON.parse(cached.value);
        if (data.fetchedAt && data.latest && data.recommended && isCacheFresh(data)) {
          // Re-filter against library in case papers were imported since cache was built
          const cache = data as RecommendationsCache;
          const [latest, recommended] = await Promise.all([
            excludeLibraryPapers(cache.latest, userId!),
            excludeLibraryPapers(cache.recommended, userId!),
          ]);
          return { latest, recommended, fetchedAt: cache.fetchedAt };
        }
      } catch {
        // stale or corrupt cache, continue to refresh
      }
    }
  }

  // Extract user interests
  const interests = await extractInterests(userId!);

  const hasSignals =
    interests.paperIds.length > 0 ||
    interests.arxivCategories.length > 0 ||
    interests.contentQueries.length > 0;

  if (!hasSignals) {
    const empty: RecommendationsCache = { latest: [], recommended: [], fetchedAt: new Date().toISOString() };
    await prisma.setting.upsert({
      where: { key: CACHE_KEY },
      create: { key: CACHE_KEY, value: JSON.stringify(empty) },
      update: { value: JSON.stringify(empty) },
    });
    return empty;
  }

  // Step 1: Fetch primary signals in parallel
  const [s2Recs, arxivLatest] = await Promise.all([
    fetchS2Recommendations(interests),
    fetchArxivLatest(interests),
  ]);

  // Step 2: Conditional keyword fallback if S2 recs insufficient
  let keywordResults: RecommendedPaper[] = [];
  if (s2Recs.length < 5) {
    keywordResults = await fetchKeywordFallback(interests);
  }

  // Step 3: Section routing
  // ArXiv → Latest section (sorted by year descending)
  let latest = deduplicateRecommendations(arxivLatest);
  latest.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  latest = latest.slice(0, 10);

  // S2 recs + keyword fallback → Recommended section
  // S2 recs keep SPECTER similarity order; keyword fallback sorted by citations
  keywordResults.sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1));
  const rawRecommended = [...s2Recs, ...keywordResults];
  let recommended = deduplicateRecommendations(rawRecommended);

  // Step 4: Cross-section dedup — remove from Recommended anything already in Latest
  const latestKeys = buildPaperKeySet(latest);
  recommended = crossSectionDedup(recommended, latestKeys);
  recommended = recommended.slice(0, 15);

  // Step 5: Exclude library papers from both sections
  [latest, recommended] = await Promise.all([
    excludeLibraryPapers(latest, userId!),
    excludeLibraryPapers(recommended, userId!),
  ]);

  const cache: RecommendationsCache = {
    latest,
    recommended,
    fetchedAt: new Date().toISOString(),
  };

  await prisma.setting.upsert({
    where: { key: CACHE_KEY },
    create: { key: CACHE_KEY, value: JSON.stringify(cache) },
    update: { value: JSON.stringify(cache) },
  });

  return cache;
}
