import { prisma } from "@/lib/prisma";
import {
  generateRecommendationProfileCandidates,
} from "@/lib/papers/retrieval/candidate-generation";
import {
  buildRecommendationSections,
  mergeRecommendationCandidates,
  rerankRecommendationCandidates,
  type RecommendationSourceHit,
} from "@/lib/papers/retrieval/recommendations-ranker";
import { mergePaperVisibilityWhere } from "@/lib/papers/visibility";
import { getS2Recommendations, searchAllSources, type S2Result } from "@/lib/import/semantic-scholar";

import { searchArxivCategories } from "./arxiv-search";
import {
  buildRecommendationProfile,
  buildRecommendationProfileFromSeedPapers,
  type RecommendationProfile,
} from "./interests";
import type {
  RecommendedPaper,
  RecommendationBuildOptions,
  RecommendationsCache,
} from "./types";

const CACHE_KEY_PREFIX = "recommendations_cache_v4";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_S2_SEEDS = 8;
const MAX_S2_RESULTS = 28;
const MAX_KEYWORD_QUERIES = 4;
const MAX_SEARCH_RESULTS_PER_QUERY = 5;
const MAX_SUPPORT_PAPERS = 8;

interface SupportSeedPaper {
  id: string;
  title: string;
  doi: string | null;
  arxivId: string | null;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function cacheKeyFor(userId: string): string {
  return `${CACHE_KEY_PREFIX}:${userId}`;
}

function isCacheFresh(cache: RecommendationsCache): boolean {
  const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
  return ageMs >= 0 && ageMs <= CACHE_MAX_AGE_MS;
}

function s2ResultToRecommended(
  result: S2Result,
  matchReason: string,
): RecommendedPaper {
  return {
    title: result.title,
    abstract: result.abstract,
    authors: result.authors,
    year: result.year,
    doi: result.doi,
    arxivId: result.arxivId,
    externalUrl: result.externalUrl,
    citationCount: result.citationCount,
    openAccessPdfUrl: result.openAccessPdfUrl,
    source: result.source || "openalex",
    matchReason,
  };
}

function normalizeRecommendationKey(paper: RecommendedPaper): string {
  if (paper.doi) return `doi:${paper.doi.toLowerCase()}`;
  if (paper.arxivId) return `arxiv:${paper.arxivId.toLowerCase()}`;
  return `title:${paper.title.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

async function excludeLibraryPapers(
  papers: RecommendedPaper[],
  userId: string,
): Promise<RecommendedPaper[]> {
  if (papers.length === 0) return papers;

  const dois = papers.map((paper) => paper.doi).filter(Boolean) as string[];
  const arxivIds = papers.map((paper) => paper.arxivId).filter(Boolean) as string[];
  const titles = papers.map((paper) => paper.title).filter(Boolean);

  const conditions = [];
  if (dois.length > 0) conditions.push({ doi: { in: dois } });
  if (arxivIds.length > 0) conditions.push({ arxivId: { in: arxivIds } });
  if (titles.length > 0) conditions.push({ title: { in: titles } });

  if (conditions.length === 0) return papers;

  const existing = await prisma.paper.findMany({
    where: mergePaperVisibilityWhere(userId, { OR: conditions }),
    select: { doi: true, arxivId: true, title: true },
  });

  const existingKeys = new Set(
    existing.flatMap((paper) => {
      const keys: string[] = [];
      if (paper.doi) keys.push(`doi:${paper.doi.toLowerCase()}`);
      if (paper.arxivId) keys.push(`arxiv:${paper.arxivId.toLowerCase()}`);
      const normalizedTitle = paper.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedTitle.length >= 10) {
        keys.push(`title:${normalizedTitle}`);
      }
      return keys;
    }),
  );

  return papers.filter((paper) => !existingKeys.has(normalizeRecommendationKey(paper)));
}

async function loadSupportSeedPapers(
  profile: RecommendationProfile,
): Promise<SupportSeedPaper[]> {
  if (profile.paperSeeds.length === 0) return [];

  const candidates = await generateRecommendationProfileCandidates({
    userId: profile.userId,
    paperIds: profile.paperSeeds.map((seed) => seed.paperId),
    limit: MAX_SUPPORT_PAPERS,
  });

  if (candidates.length === 0) return [];

  return prisma.paper.findMany({
    where: mergePaperVisibilityWhere(profile.userId, {
      id: { in: candidates.map((candidate) => candidate.paperId) },
    }),
    select: {
      id: true,
      title: true,
      doi: true,
      arxivId: true,
    },
  });
}

async function fetchInternalRecommendationHits(
  profile: RecommendationProfile,
): Promise<RecommendationSourceHit[]> {
  const candidates = await generateRecommendationProfileCandidates({
    userId: profile.userId,
    paperIds: profile.paperSeeds.map((seed) => seed.paperId),
    limit: 48,
  });

  if (candidates.length === 0) return [];

  const papers = await prisma.paper.findMany({
    where: mergePaperVisibilityWhere(profile.userId, {
      id: { in: candidates.map((candidate) => candidate.paperId) },
    }),
    select: {
      id: true,
      title: true,
      abstract: true,
      authors: true,
      year: true,
      doi: true,
      arxivId: true,
      citationCount: true,
    },
  });

  const paperById = new Map(papers.map((paper) => [paper.id, paper]));

  return candidates.flatMap((candidate) => {
    const paper = paperById.get(candidate.paperId);
    if (!paper) return [];
    return [
      {
        paper: {
          title: paper.title,
          abstract: paper.abstract,
          authors: (() => {
            try {
              return Array.isArray(JSON.parse(paper.authors ?? "[]"))
                ? JSON.parse(paper.authors ?? "[]")
                : [];
            } catch {
              return [];
            }
          })(),
          year: paper.year,
          doi: paper.doi,
          arxivId: paper.arxivId,
          externalUrl: paper.doi
            ? `https://doi.org/${paper.doi}`
            : paper.arxivId
              ? `https://arxiv.org/abs/${paper.arxivId}`
              : "",
          citationCount: paper.citationCount,
          openAccessPdfUrl: null,
          source: "internal-profile",
          matchReason: `Internal profile match: ${candidate.title}`,
        },
        sourceKind: "internal" as const,
        seedHint: null,
      },
    ];
  });
}

async function fetchS2RecommendationHits(
  profile: RecommendationProfile,
  supportPapers: SupportSeedPaper[],
): Promise<RecommendationSourceHit[]> {
  const positivePaperIds = [
    ...profile.paperSeeds.map((seed) => seed.externalSeedId).filter(Boolean),
    ...supportPapers.map((paper) => (paper.doi ? `DOI:${paper.doi}` : paper.arxivId ? `ArXiv:${paper.arxivId}` : null)).filter(Boolean),
  ].slice(0, MAX_S2_SEEDS) as string[];

  if (positivePaperIds.length === 0) return [];

  try {
    const results = await getS2Recommendations(positivePaperIds, MAX_S2_RESULTS);
    return results.map((result) => ({
      paper: s2ResultToRecommended(result, "Based on your library profile"),
      sourceKind: "s2" as const,
      seedHint: null,
    }));
  } catch (error) {
    console.warn("[recommendations] S2 recommendations failed:", error);
    return [];
  }
}

async function fetchArxivRecommendationHits(
  profile: RecommendationProfile,
): Promise<RecommendationSourceHit[]> {
  if (profile.arxivCategories.length === 0) return [];

  try {
    const results = await searchArxivCategories(profile.arxivCategories, 4);
    return results.map((paper) => ({
      paper,
      sourceKind: "arxiv" as const,
      seedHint: null,
    }));
  } catch (error) {
    console.warn("[recommendations] arXiv category search failed:", error);
    return [];
  }
}

async function fetchKeywordRecommendationHits(
  profile: RecommendationProfile,
  supportPapers: SupportSeedPaper[],
): Promise<RecommendationSourceHit[]> {
  const extraQueries = supportPapers
    .slice(0, 2)
    .map((paper) => ({
      query: paper.title,
      sourcePaperTitle: paper.title,
      weight: 0.45,
      source: "title" as const,
    }));

  const queries = [...profile.contentQueries, ...extraQueries].slice(0, MAX_KEYWORD_QUERIES);
  if (queries.length === 0) return [];

  const recentYear = profile.newestYear ? profile.newestYear - 1 : null;

  const results = await Promise.all(
    queries.map(async (query) => {
      try {
        const rows = await searchAllSources(query.query, recentYear);
        return rows
          .slice(0, MAX_SEARCH_RESULTS_PER_QUERY)
          .map((row) => ({
            paper: s2ResultToRecommended(row, `Matched: ${query.sourcePaperTitle}`),
            sourceKind: "keyword" as const,
            seedHint: query.sourcePaperTitle,
          }));
      } catch (error) {
        console.warn(`[recommendations] keyword search failed for "${query.query}":`, error);
        return [] as RecommendationSourceHit[];
      }
    }),
  );

  return results.flat();
}

async function buildRecommendationsFromProfile(
  profile: RecommendationProfile,
  options: RecommendationBuildOptions = {},
): Promise<RecommendationsCache> {
  if (profile.paperSeeds.length === 0) {
    return {
      latest: [],
      recommended: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  const supportPapers = await loadSupportSeedPapers(profile);
  const includeExternalSources = options.includeExternalSources ?? true;
  const [internalHits, s2Hits, arxivHits, keywordHits] = await Promise.all([
    fetchInternalRecommendationHits(profile),
    includeExternalSources
      ? fetchS2RecommendationHits(profile, supportPapers)
      : Promise.resolve([]),
    includeExternalSources
      ? fetchArxivRecommendationHits(profile)
      : Promise.resolve([]),
    includeExternalSources
      ? fetchKeywordRecommendationHits(profile, supportPapers)
      : Promise.resolve([]),
  ]);

  const mergedCandidates = mergeRecommendationCandidates([
    ...internalHits,
    ...s2Hits,
    ...arxivHits,
    ...keywordHits,
  ]);

  let visibleCandidates = mergedCandidates;
  if (!options.allowLibraryCandidates) {
    const candidatePapers = mergedCandidates.map(
      (candidate) => candidate as RecommendedPaper,
    );
    const filteredPapers = await excludeLibraryPapers(
      candidatePapers,
      profile.userId,
    );
    const candidateKeySet = new Set(
      filteredPapers.map((paper) => normalizeRecommendationKey(paper)),
    );
    visibleCandidates = mergedCandidates.filter((candidate) =>
      candidateKeySet.has(candidate.dedupeKey),
    );
  }

  const rankedCandidates = rerankRecommendationCandidates(profile, visibleCandidates);
  const sections = buildRecommendationSections(profile, rankedCandidates);

  return {
    latest: sections.latest,
    recommended: sections.recommended,
    fetchedAt: new Date().toISOString(),
  };
}

async function readCachedRecommendations(
  userId: string,
): Promise<RecommendationsCache | null> {
  const cached = await prisma.setting.findUnique({
    where: { key: cacheKeyFor(userId) },
  });

  if (!cached) return null;

  try {
    const parsed = JSON.parse(cached.value) as RecommendationsCache;
    if (!parsed.latest || !parsed.recommended || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedRecommendations(
  userId: string,
  cache: RecommendationsCache,
): Promise<void> {
  await prisma.setting.upsert({
    where: { key: cacheKeyFor(userId) },
    create: { key: cacheKeyFor(userId), value: JSON.stringify(cache) },
    update: { value: JSON.stringify(cache) },
  });
}

export async function getRecommendations(
  forceRefresh = false,
  userId?: string,
  tagIds?: string[],
  options: RecommendationBuildOptions = {},
): Promise<RecommendationsCache> {
  if (!userId) {
    return {
      latest: [],
      recommended: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  if (!forceRefresh && (!tagIds || tagIds.length === 0)) {
    const cached = await readCachedRecommendations(userId);
    if (cached && isCacheFresh(cached)) {
      const [latest, recommended] = await Promise.all([
        excludeLibraryPapers(cached.latest, userId),
        excludeLibraryPapers(cached.recommended, userId),
      ]);
      return {
        latest,
        recommended,
        fetchedAt: cached.fetchedAt,
      };
    }
  }

  const profile = await buildRecommendationProfile(userId, tagIds);
  const recommendations = await buildRecommendationsFromProfile(profile, options);

  if (!tagIds || tagIds.length === 0) {
    await writeCachedRecommendations(userId, recommendations);
  }

  return recommendations;
}

export async function getRecommendationsForSeedPapers(params: {
  userId: string;
  paperIds: string[];
  profileDescription?: string;
  options?: RecommendationBuildOptions;
}): Promise<RecommendationsCache> {
  const profile = await buildRecommendationProfileFromSeedPapers({
    userId: params.userId,
    paperIds: params.paperIds,
    profileDescription: params.profileDescription,
  });
  return buildRecommendationsFromProfile(profile, params.options);
}
