import { prisma } from "@/lib/prisma";
import { mergePaperVisibilityWhere } from "@/lib/papers/visibility";
import {
  averageVectors,
  ensureSharedPaperRepresentations,
  getPaperRepresentation,
  type PaperRepresentationDb,
} from "@/lib/papers/retrieval";

export interface ContentQuery {
  query: string;
  sourcePaperTitle: string;
  weight: number;
  source:
    | "title"
    | "finding"
    | "tag"
    | "facet"
    | "profile-description";
}

export interface RecommendationPaperSeed {
  paperId: string;
  title: string;
  weight: number;
  doi: string | null;
  arxivId: string | null;
  citationCount: number | null;
  tagNames: string[];
  claimFacets: string[];
  externalSeedId: string | null;
}

export interface WeightedProfileSignal {
  value: string;
  weight: number;
}

export interface RecommendationProfile {
  userId: string;
  paperSeeds: RecommendationPaperSeed[];
  arxivCategories: string[];
  contentQueries: ContentQuery[];
  tagWeights: WeightedProfileSignal[];
  claimFacetWeights: WeightedProfileSignal[];
  newestYear: number | null;
  profileVector: number[];
  seedVectors: Array<{ paperId: string; vector: number[] }>;
  relatedConsumptionPaperIds: string[];
}

type RecommendationProfileDb = Pick<
  typeof prisma,
  "paper" | "paperEngagement" | "conversation"
> &
  PaperRepresentationDb;

interface ProfileSourcePaper {
  id: string;
  title: string;
  keyFindings: string | null;
  isLiked: boolean;
  engagementScore: number;
  doi: string | null;
  arxivId: string | null;
  year: number | null;
  citationCount: number | null;
  tags: Array<{ tag: { name: string } }>;
  claims: Array<{ facet: string; normalizedText: string }>;
}

const ACADEMIC_PREFIX_RE =
  /^(a\s+)?(study|survey|review|analysis|investigation|exploration|overview|examination|comparison)\s+(of|on|in)\s+/i;
const ARXIV_CATEGORY_RE = /^[a-z-]+(\.[A-Z]{2,})?$/;
const MAX_PROFILE_SEEDS = 12;
const MAX_TITLE_QUERIES = 6;
const MAX_FINDING_QUERIES = 2;
const MAX_TAG_QUERIES = 2;
const MAX_FACET_QUERIES = 2;

const TAG_TO_CATEGORY_MAP: Record<string, string> = {
  "machine learning": "cs.LG",
  "deep learning": "cs.LG",
  "natural language processing": "cs.CL",
  nlp: "cs.CL",
  "computer vision": "cs.CV",
  "reinforcement learning": "cs.LG",
  "artificial intelligence": "cs.AI",
  robotics: "cs.RO",
  "information retrieval": "cs.IR",
  retrieval: "cs.IR",
  speech: "cs.SD",
  cryptography: "cs.CR",
  databases: "cs.DB",
  networks: "cs.NI",
  optimization: "math.OC",
  statistics: "stat.ML",
  multimodal: "cs.CV",
  vision: "cs.CV",
  language: "cs.CL",
};

const FACET_QUERY_MAP: Record<string, string> = {
  PROBLEM: "research problem benchmark task",
  APPROACH: "method approach architecture training",
  RESULT: "results performance improvement",
  COMPARISON: "benchmark comparison baseline evaluation",
  LIMITATION: "efficiency limitation robustness memory latency",
  RESOURCE: "dataset benchmark corpus resource",
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanTitle(title: string): string {
  let cleaned = title.replace(ACADEMIC_PREFIX_RE, "").trim();
  if (cleaned.length > 96) {
    cleaned = cleaned.slice(0, 96).replace(/\s\S*$/, "");
  }
  return cleaned;
}

function truncateQuery(text: string, maxLen = 96): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen).replace(/\s\S*$/, "");
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => normalizeWhitespace(item))
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
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

function accumulateWeight(
  bucket: Map<string, number>,
  value: string,
  weight: number,
): void {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return;
  bucket.set(normalized, (bucket.get(normalized) ?? 0) + weight);
}

function topWeightedSignals(
  bucket: Map<string, number>,
  limit: number,
): WeightedProfileSignal[] {
  return Array.from(bucket.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([value, weight]) => ({ value, weight: round(weight) }));
}

function computeEngagementBoost(events: Array<{ event: string }>): number {
  let score = 0;
  for (const event of events) {
    switch (event.event) {
      case "chat":
        score += 1.6;
        break;
      case "pdf_open":
        score += 0.5;
        break;
      case "annotate":
        score += 1.3;
        break;
      case "discovery_seed":
        score += 1.1;
        break;
      case "import":
        score += 0.8;
        break;
      default:
        score += 0.2;
        break;
    }
  }
  return score;
}

function externalSeedIdForPaper(paper: {
  doi: string | null;
  arxivId: string | null;
}): string | null {
  if (paper.doi) return `DOI:${paper.doi}`;
  if (paper.arxivId) return `ArXiv:${paper.arxivId}`;
  return null;
}

async function buildProfileVector(
  paperIds: string[],
  db: RecommendationProfileDb,
): Promise<{
  profileVector: number[];
  seedVectors: Array<{ paperId: string; vector: number[] }>;
}> {
  const uniquePaperIds = stableUnique(paperIds).slice(0, MAX_PROFILE_SEEDS);
  if (uniquePaperIds.length === 0) {
    return { profileVector: [], seedVectors: [] };
  }

  await ensureSharedPaperRepresentations(uniquePaperIds, db);
  const representations = await Promise.all(
    uniquePaperIds.map(async (paperId) => ({
      paperId,
      representation: await getPaperRepresentation(db, paperId),
    })),
  );

  const seedVectors = representations
    .filter(
      (row): row is {
        paperId: string;
        representation: NonNullable<Awaited<ReturnType<typeof getPaperRepresentation>>>;
      } => Boolean(row.representation?.vector?.length),
    )
    .map((row) => ({
      paperId: row.paperId,
      vector: row.representation.vector,
    }));

  return {
    profileVector: averageVectors(seedVectors.map((row) => row.vector)),
    seedVectors,
  };
}

async function assembleRecommendationProfile(
  params: {
    userId: string;
    sourcePapers: ProfileSourcePaper[];
    paperWeights: Map<string, number>;
    profileDescription?: string;
    relatedConsumptionPaperIds?: string[];
  },
  db: RecommendationProfileDb,
): Promise<RecommendationProfile> {
  const sortedSeedPapers = params.sourcePapers
    .map((paper) => ({
      paper,
      weight: params.paperWeights.get(paper.id) ?? 0,
    }))
    .filter((row) => row.weight > 0)
    .sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight;
      return left.paper.title.localeCompare(right.paper.title);
    })
    .slice(0, MAX_PROFILE_SEEDS);

  const maxWeight = Math.max(...sortedSeedPapers.map((row) => row.weight), 1);
  const paperSeeds: RecommendationPaperSeed[] = sortedSeedPapers.map(
    ({ paper, weight }) => ({
      paperId: paper.id,
      title: paper.title,
      weight: round(weight / maxWeight),
      doi: paper.doi,
      arxivId: paper.arxivId,
      citationCount: paper.citationCount,
      tagNames: stableUnique(paper.tags.map(({ tag }) => normalizeWhitespace(tag.name))),
      claimFacets: stableUnique(paper.claims.map((claim) => claim.facet)),
      externalSeedId: externalSeedIdForPaper(paper),
    }),
  );

  const tagBucket = new Map<string, number>();
  const facetBucket = new Map<string, number>();
  const queryBucket = new Map<string, ContentQuery>();

  for (const seed of paperSeeds) {
    for (const tagName of seed.tagNames) {
      accumulateWeight(tagBucket, tagName, seed.weight);
    }
    for (const facet of seed.claimFacets) {
      accumulateWeight(facetBucket, facet, seed.weight);
    }

    if (queryBucket.size < MAX_TITLE_QUERIES) {
      const cleaned = cleanTitle(seed.title);
      if (cleaned.length >= 15) {
        queryBucket.set(`title:${cleaned}`, {
          query: cleaned,
          sourcePaperTitle: seed.title,
          weight: seed.weight,
          source: "title",
        });
      }
    }
  }

  for (const { paper, weight } of sortedSeedPapers) {
    if (queryBucket.size >= MAX_TITLE_QUERIES + MAX_FINDING_QUERIES) break;
    for (const finding of parseJsonStringArray(paper.keyFindings).slice(0, 2)) {
      const query = truncateQuery(finding);
      if (query.length < 20) continue;
      const key = `finding:${query}`;
      if (queryBucket.has(key)) continue;
      queryBucket.set(key, {
        query,
        sourcePaperTitle: paper.title,
        weight: round(weight / maxWeight),
        source: "finding",
      });
      if (
        Array.from(queryBucket.values()).filter((entry) => entry.source === "finding")
          .length >= MAX_FINDING_QUERIES
      ) {
        break;
      }
    }
  }

  for (const signal of topWeightedSignals(tagBucket, MAX_TAG_QUERIES)) {
    const key = `tag:${signal.value}`;
    if (queryBucket.has(key)) continue;
    queryBucket.set(key, {
      query: signal.value,
      sourcePaperTitle: `Tag profile: ${signal.value}`,
      weight: signal.weight,
      source: "tag",
    });
  }

  for (const signal of topWeightedSignals(facetBucket, MAX_FACET_QUERIES)) {
    const facetQuery = FACET_QUERY_MAP[signal.value];
    if (!facetQuery) continue;
    const key = `facet:${signal.value}`;
    if (queryBucket.has(key)) continue;
    queryBucket.set(key, {
      query: facetQuery,
      sourcePaperTitle: `Facet profile: ${signal.value.toLowerCase()}`,
      weight: signal.weight,
      source: "facet",
    });
  }

  if (params.profileDescription) {
    const query = truncateQuery(params.profileDescription);
    if (query.length >= 20) {
      queryBucket.set(`profile:${query}`, {
        query,
        sourcePaperTitle: "Profile description",
        weight: 0.65,
        source: "profile-description",
      });
    }
  }

  const arxivCategories = topWeightedSignals(tagBucket, 8)
    .map((signal) => TAG_TO_CATEGORY_MAP[signal.value.toLowerCase()])
    .filter((value): value is string => Boolean(value) && ARXIV_CATEGORY_RE.test(value))
    .slice(0, 4);

  const newestYear = params.sourcePapers.reduce<number | null>(
    (maxYear, paper) => {
      if (paper.year == null) return maxYear;
      return maxYear == null ? paper.year : Math.max(maxYear, paper.year);
    },
    null,
  );

  const { profileVector, seedVectors } = await buildProfileVector(
    paperSeeds.map((seed) => seed.paperId),
    db,
  );

  return {
    userId: params.userId,
    paperSeeds,
    arxivCategories: stableUnique(arxivCategories),
    contentQueries: Array.from(queryBucket.values()).slice(
      0,
      MAX_TITLE_QUERIES + MAX_FINDING_QUERIES + MAX_TAG_QUERIES + MAX_FACET_QUERIES + 1,
    ),
    tagWeights: topWeightedSignals(tagBucket, 8),
    claimFacetWeights: topWeightedSignals(facetBucket, 6),
    newestYear,
    profileVector,
    seedVectors,
    relatedConsumptionPaperIds: stableUnique(params.relatedConsumptionPaperIds ?? []),
  };
}

async function loadSourcePapers(
  userId: string,
  tagIds: string[] | undefined,
  db: RecommendationProfileDb,
): Promise<ProfileSourcePaper[]> {
  const tagScope =
    tagIds && tagIds.length > 0
      ? { tags: { some: { tagId: { in: tagIds } } } }
      : {};

  return db.paper.findMany({
    where: mergePaperVisibilityWhere(userId, {
      processingStatus: "COMPLETED",
      ...tagScope,
      ...(tagIds && tagIds.length > 0
        ? {}
        : {
            OR: [
              { isLiked: true },
              { engagementScore: { gt: 0 } },
              { conversations: { some: {} } },
              { engagements: { some: { event: { in: ["chat", "discovery_seed", "import"] } } } },
            ],
          }),
    }),
    select: {
      id: true,
      title: true,
      keyFindings: true,
      isLiked: true,
      engagementScore: true,
      doi: true,
      arxivId: true,
      year: true,
      citationCount: true,
      tags: {
        select: {
          tag: {
            select: {
              name: true,
            },
          },
        },
      },
      claims: {
        orderBy: {
          orderIndex: "asc",
        },
        select: {
          facet: true,
          normalizedText: true,
        },
        take: 16,
      },
    },
    orderBy:
      tagIds && tagIds.length > 0
        ? [{ citationCount: "desc" }, { year: "desc" }, { updatedAt: "desc" }]
        : [{ isLiked: "desc" }, { engagementScore: "desc" }, { updatedAt: "desc" }],
    take: 28,
  }) as Promise<ProfileSourcePaper[]>;
}

async function loadExplicitSeedPapers(
  userId: string,
  paperIds: string[],
  db: RecommendationProfileDb,
): Promise<ProfileSourcePaper[]> {
  return db.paper.findMany({
    where: mergePaperVisibilityWhere(userId, {
      id: { in: stableUnique(paperIds) },
    }),
    select: {
      id: true,
      title: true,
      keyFindings: true,
      isLiked: true,
      engagementScore: true,
      doi: true,
      arxivId: true,
      year: true,
      citationCount: true,
      tags: {
        select: {
          tag: {
            select: {
              name: true,
            },
          },
        },
      },
      claims: {
        orderBy: {
          orderIndex: "asc",
        },
        select: {
          facet: true,
          normalizedText: true,
        },
        take: 16,
      },
    },
  }) as Promise<ProfileSourcePaper[]>;
}

export async function buildRecommendationProfile(
  userId: string,
  tagIds?: string[],
  db: RecommendationProfileDb = prisma,
): Promise<RecommendationProfile> {
  const sourcePapers = await loadSourcePapers(userId, tagIds, db);
  const sourcePaperIds = sourcePapers.map((paper) => paper.id);
  const [engagements, conversations] = await Promise.all([
    db.paperEngagement.findMany({
      where: { paperId: { in: sourcePaperIds } },
      select: { paperId: true, event: true },
    }),
    db.conversation.findMany({
      where: { paperId: { in: sourcePaperIds } },
      select: {
        paperId: true,
        _count: {
          select: {
            messages: true,
            additionalPapers: true,
            artifacts: true,
          },
        },
      },
    }),
  ]);

  const engagementByPaper = new Map<string, Array<{ event: string }>>();
  for (const engagement of engagements) {
    const rows = engagementByPaper.get(engagement.paperId) ?? [];
    rows.push({ event: engagement.event });
    engagementByPaper.set(engagement.paperId, rows);
  }

  const conversationByPaper = new Map<
    string,
    { messageCount: number; additionalPaperCount: number; artifactCount: number; conversationCount: number }
  >();
  for (const conversation of conversations) {
    const current = conversationByPaper.get(conversation.paperId) ?? {
      messageCount: 0,
      additionalPaperCount: 0,
      artifactCount: 0,
      conversationCount: 0,
    };
    current.messageCount += conversation._count.messages;
    current.additionalPaperCount += conversation._count.additionalPapers;
    current.artifactCount += conversation._count.artifacts;
    current.conversationCount += 1;
    conversationByPaper.set(conversation.paperId, current);
  }

  const paperWeights = new Map<string, number>();
  const relatedConsumptionPaperIds: string[] = [];
  const newestYear = sourcePapers.reduce<number | null>(
    (maxYear, paper) => {
      if (paper.year == null) return maxYear;
      return maxYear == null ? paper.year : Math.max(maxYear, paper.year);
    },
    null,
  );

  for (const paper of sourcePapers) {
    const conversationSignals = conversationByPaper.get(paper.id);
    const paperEngagements = engagementByPaper.get(paper.id) ?? [];
    const relatedConsumptionScore =
      (conversationSignals?.additionalPaperCount ?? 0) * 0.55
      + paperEngagements.filter((event) =>
        event.event === "discovery_seed" || event.event === "import",
      ).length
        * 0.9;

    if (relatedConsumptionScore > 0) {
      relatedConsumptionPaperIds.push(paper.id);
    }

    const engagementWeight =
      Math.min(paper.engagementScore, 12) * 0.55
      + (paper.isLiked ? 2.5 : 0)
      + computeEngagementBoost(paperEngagements)
      + (conversationSignals?.conversationCount ?? 0) * 0.7
      + (conversationSignals?.messageCount ?? 0) * 0.05
      + (conversationSignals?.artifactCount ?? 0) * 0.25
      + relatedConsumptionScore;

    const filteredBaselineWeight =
      tagIds && tagIds.length > 0
        ? 1
          + clamp(Math.log1p(Math.max(0, paper.citationCount ?? 0)) / 7) * 0.8
          + (paper.year != null && newestYear != null
            ? clamp((paper.year - (newestYear - 6)) / 6) * 0.45
            : 0.15)
        : 0;

    const weight = tagIds && tagIds.length > 0
      ? Math.max(filteredBaselineWeight, engagementWeight)
      : engagementWeight;

    paperWeights.set(paper.id, weight);
  }

  return assembleRecommendationProfile(
    {
      userId,
      sourcePapers,
      paperWeights,
      relatedConsumptionPaperIds,
    },
    db,
  );
}

export async function buildRecommendationProfileFromSeedPapers(
  params: {
    userId: string;
    paperIds: string[];
    profileDescription?: string;
  },
  db: RecommendationProfileDb = prisma,
): Promise<RecommendationProfile> {
  const sourcePapers = await loadExplicitSeedPapers(params.userId, params.paperIds, db);
  const paperWeights = new Map<string, number>();

  sourcePapers
    .sort((left, right) => params.paperIds.indexOf(left.id) - params.paperIds.indexOf(right.id))
    .forEach((paper, index) => {
      paperWeights.set(paper.id, Math.max(0.6, 1 - index * 0.08));
    });

  return assembleRecommendationProfile(
    {
      userId: params.userId,
      sourcePapers,
      paperWeights,
      profileDescription: params.profileDescription,
      relatedConsumptionPaperIds: [],
    },
    db,
  );
}

export async function extractInterests(
  userId: string,
  tagIds?: string[],
): Promise<RecommendationProfile> {
  return buildRecommendationProfile(userId, tagIds);
}
