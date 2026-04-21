import type { RecommendationProfile } from "@/lib/recommendations/interests";
import type { RecommendedPaper } from "@/lib/recommendations/types";

import {
  buildSharedPaperFeatureDocument,
  cosineSimilarity,
  encodeFeatureSectionsToVector,
} from "./embeddings";
import { diversifyCandidates } from "./diversify";

export interface RecommendationSourceHit {
  paper: RecommendedPaper;
  sourceKind: "internal" | "s2" | "arxiv" | "keyword";
  seedHint?: string | null;
}

export interface RecommendationCandidate extends RecommendedPaper {
  dedupeKey: string;
  sourceKinds: RecommendationSourceHit["sourceKind"][];
  sourceLabels: string[];
  sourceCount: number;
  seedHints: string[];
  matchReasons: string[];
}

export interface RankedRecommendationCandidate extends RecommendationCandidate {
  profileSimilarity: number;
  noveltyScore: number;
  freshnessScore: number;
  sourceSupportScore: number;
  lexicalOverlapScore: number;
  citationScore: number;
  hubScore: number;
  rerankScore: number;
  latestScore: number;
  vector: number[];
  subtopics: string[];
}

export interface RecommendationSectionResult {
  latest: RecommendedPaper[];
  recommended: RecommendedPaper[];
  rankedLatest: RankedRecommendationCandidate[];
  rankedRecommended: RankedRecommendationCandidate[];
}

const SOURCE_KIND_WEIGHTS: Record<RecommendationSourceHit["sourceKind"], number> = {
  internal: 0.9,
  s2: 1,
  arxiv: 0.72,
  keyword: 0.78,
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeText(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string | null | undefined): string[] {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function stableUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function recommendationKey(paper: RecommendedPaper): string {
  if (paper.doi) return `doi:${paper.doi.toLowerCase()}`;
  if (paper.arxivId) return `arxiv:${paper.arxivId.toLowerCase()}`;
  return `title:${normalizeText(paper.title).replace(/\s+/g, "")}`;
}

function buildCandidateVector(candidate: RecommendationCandidate): number[] {
  const featureDocument = buildSharedPaperFeatureDocument({
    title: candidate.title,
    abstract: candidate.abstract,
    summary:
      candidate.matchReasons.length > 0
        ? candidate.matchReasons.join(" | ")
        : candidate.matchReason ?? null,
    keyFindings: null,
    authors: JSON.stringify(candidate.authors),
    venue: null,
    year: candidate.year,
    tags: [],
    claims: [],
  });
  return encodeFeatureSectionsToVector(featureDocument.sections);
}

function lexicalOverlapScore(
  candidate: RecommendationCandidate,
  profile: RecommendationProfile,
): number {
  const candidateTokens = new Set(
    stableUnique([
      ...tokenize(candidate.title),
      ...tokenize(candidate.abstract),
      ...candidate.matchReasons.flatMap((reason) => tokenize(reason)),
    ]),
  );
  if (candidateTokens.size === 0) return 0;

  const weightedTerms = new Map<string, number>();
  for (const tag of profile.tagWeights) {
    for (const token of tokenize(tag.value)) {
      weightedTerms.set(token, Math.max(weightedTerms.get(token) ?? 0, tag.weight));
    }
  }
  for (const query of profile.contentQueries.slice(0, 8)) {
    for (const token of tokenize(query.query)) {
      weightedTerms.set(token, Math.max(weightedTerms.get(token) ?? 0, query.weight));
    }
  }

  let hitWeight = 0;
  let totalWeight = 0;
  for (const [term, weight] of Array.from(weightedTerms.entries())) {
    totalWeight += weight;
    if (candidateTokens.has(term)) {
      hitWeight += weight;
    }
  }
  if (totalWeight === 0) return 0;
  return round(hitWeight / totalWeight);
}

function freshnessScore(year: number | null, newestYear: number | null): number {
  if (year == null) return 0.1;
  const anchor = newestYear ?? new Date().getFullYear();
  return round(clamp((year - (anchor - 6)) / 6));
}

function sourceSupportScore(
  candidate: RecommendationCandidate,
  profile: RecommendationProfile,
): number {
  const sourceWeight = candidate.sourceKinds.reduce(
    (sum, sourceKind) => sum + SOURCE_KIND_WEIGHTS[sourceKind],
    0,
  );
  const normalizedSourceWeight = clamp(sourceWeight / 2.5);
  const normalizedSeedSupport = clamp(
    candidate.seedHints.length / Math.max(1, Math.min(profile.paperSeeds.length, 6)),
  );
  return round(normalizedSourceWeight * 0.65 + normalizedSeedSupport * 0.35);
}

function noveltyScore(vector: number[], profile: RecommendationProfile): number {
  if (profile.seedVectors.length === 0 || vector.length === 0) return 0.5;
  const maxSeedSimilarity = profile.seedVectors.reduce(
    (maxSimilarity, seed) => Math.max(maxSimilarity, cosineSimilarity(vector, seed.vector)),
    0,
  );
  return round(clamp(1 - maxSeedSimilarity));
}

function citationScore(citationCount: number | null): number {
  if (!citationCount || citationCount <= 0) return 0;
  return round(clamp(Math.log1p(citationCount) / 7));
}

function hubScore(citationCount: number | null): number {
  if (!citationCount || citationCount <= 0) return 0;
  return round(clamp(Math.log1p(citationCount) / 9));
}

function deriveSubtopics(
  candidate: RecommendationCandidate,
  profile: RecommendationProfile,
): string[] {
  const candidateTokens = stableUnique([
    ...tokenize(candidate.title),
    ...candidate.matchReasons.flatMap((reason) => tokenize(reason)),
  ]);
  const profileTerms = stableUnique([
    ...profile.tagWeights.flatMap((tag) => tokenize(tag.value)),
    ...profile.contentQueries.slice(0, 4).flatMap((query) => tokenize(query.query)),
  ]);

  const overlapping = candidateTokens.filter((token) => profileTerms.includes(token));
  if (overlapping.length > 0) {
    return overlapping.slice(0, 4);
  }

  return candidateTokens.slice(0, 3);
}

export function mergeRecommendationCandidates(
  hits: RecommendationSourceHit[],
): RecommendationCandidate[] {
  const merged = new Map<string, RecommendationCandidate>();

  for (const hit of hits) {
    const key = recommendationKey(hit.paper);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...hit.paper,
        dedupeKey: key,
        sourceKinds: [hit.sourceKind],
        sourceLabels: [hit.paper.source],
        sourceCount: 1,
        seedHints: hit.seedHint ? [hit.seedHint] : [],
        matchReasons: hit.paper.matchReason ? [hit.paper.matchReason] : [],
      });
      continue;
    }

    merged.set(key, {
      ...existing,
      abstract: existing.abstract ?? hit.paper.abstract,
      authors: existing.authors.length >= hit.paper.authors.length
        ? existing.authors
        : hit.paper.authors,
      year: existing.year ?? hit.paper.year,
      doi: existing.doi ?? hit.paper.doi,
      arxivId: existing.arxivId ?? hit.paper.arxivId,
      externalUrl: existing.externalUrl || hit.paper.externalUrl,
      citationCount: Math.max(existing.citationCount ?? 0, hit.paper.citationCount ?? 0) || null,
      openAccessPdfUrl: existing.openAccessPdfUrl ?? hit.paper.openAccessPdfUrl,
      source: existing.sourceKinds.includes("s2") ? existing.source : hit.paper.source,
      matchReason: stableUnique([
        ...existing.matchReasons,
        ...(hit.paper.matchReason ? [hit.paper.matchReason] : []),
      ]).slice(0, 2).join(" • ") || existing.matchReason,
      sourceKinds: stableUnique([...existing.sourceKinds, hit.sourceKind]) as RecommendationSourceHit["sourceKind"][],
      sourceLabels: stableUnique([...existing.sourceLabels, hit.paper.source]),
      sourceCount: stableUnique([...existing.sourceKinds, hit.sourceKind]).length,
      seedHints: stableUnique([
        ...existing.seedHints,
        ...(hit.seedHint ? [hit.seedHint] : []),
      ]),
      matchReasons: stableUnique([
        ...existing.matchReasons,
        ...(hit.paper.matchReason ? [hit.paper.matchReason] : []),
      ]),
    });
  }

  return Array.from(merged.values());
}

export function rerankRecommendationCandidates(
  profile: RecommendationProfile,
  candidates: RecommendationCandidate[],
): RankedRecommendationCandidate[] {
  return candidates
    .map((candidate) => {
      const vector = buildCandidateVector(candidate);
      const profileSimilarity =
        profile.profileVector.length > 0 && vector.length > 0
          ? cosineSimilarity(profile.profileVector, vector)
          : 0;
      const novelty = noveltyScore(vector, profile);
      const freshness = freshnessScore(candidate.year, profile.newestYear);
      const support = sourceSupportScore(candidate, profile);
      const lexical = lexicalOverlapScore(candidate, profile);
      const citations = citationScore(candidate.citationCount);
      const hub = hubScore(candidate.citationCount);

      const rerankScore = round(
        profileSimilarity * 0.42
          + support * 0.18
          + lexical * 0.12
          + freshness * 0.08
          + citations * 0.07
          + novelty * 0.1
          - hub * 0.05,
      );

      const latestScore = round(
        freshness * 0.5
          + profileSimilarity * 0.24
          + support * 0.1
          + lexical * 0.08
          + novelty * 0.08,
      );

      return {
        ...candidate,
        profileSimilarity: round(profileSimilarity),
        noveltyScore: novelty,
        freshnessScore: freshness,
        sourceSupportScore: support,
        lexicalOverlapScore: lexical,
        citationScore: citations,
        hubScore: hub,
        rerankScore,
        latestScore,
        vector,
        subtopics: deriveSubtopics(candidate, profile),
      };
    })
    .sort((left, right) => {
      if (right.rerankScore !== left.rerankScore) {
        return right.rerankScore - left.rerankScore;
      }
      return left.dedupeKey.localeCompare(right.dedupeKey);
    });
}

export function buildRecommendationSections(
  profile: RecommendationProfile,
  rankedCandidates: RankedRecommendationCandidate[],
): RecommendationSectionResult {
  const recommendedCandidates = diversifyCandidates(
    rankedCandidates.map((candidate) => ({
      ...candidate,
      id: candidate.dedupeKey,
      relevanceScore: candidate.rerankScore,
      hubScore: candidate.hubScore,
      noveltyScore: candidate.noveltyScore,
      subtopics: candidate.subtopics,
      vector: candidate.vector,
    })),
    {
      task: "recommendations",
      limit: 15,
    },
  );

  const recommendedKeys = new Set(recommendedCandidates.map((candidate) => candidate.dedupeKey));

  const latestCandidates = diversifyCandidates(
    rankedCandidates
      .filter((candidate) => !recommendedKeys.has(candidate.dedupeKey))
      .sort((left, right) => {
        if (right.latestScore !== left.latestScore) {
          return right.latestScore - left.latestScore;
        }
        return left.dedupeKey.localeCompare(right.dedupeKey);
      })
      .map((candidate) => ({
        ...candidate,
        id: candidate.dedupeKey,
        relevanceScore: candidate.latestScore,
        hubScore: candidate.hubScore,
        noveltyScore: candidate.noveltyScore,
        subtopics: candidate.subtopics,
        vector: candidate.vector,
      })),
    {
      task: "recommendations",
      limit: 10,
      noveltyWeight: 0.14,
      hubPenalty: 0.12,
    },
  )
    .sort((left, right) => {
      if (right.latestScore !== left.latestScore) {
        return right.latestScore - left.latestScore;
      }
      return left.dedupeKey.localeCompare(right.dedupeKey);
    });

  return {
    latest: latestCandidates.map(({ vector: _vector, subtopics: _subtopics, ...candidate }) => candidate),
    recommended: recommendedCandidates.map(({ vector: _vector, subtopics: _subtopics, ...candidate }) => candidate),
    rankedLatest: latestCandidates,
    rankedRecommended: recommendedCandidates,
  };
}
