import { z } from "zod";

import { listRelationsForPaper } from "../../assertions/relation-reader";
import { prisma } from "../../prisma";

import {
  buildRelatedRerankResult,
  type BuildRelatedRerankOptions,
  type RelatedRerankCandidateDiagnostics,
  type RelatedRerankerBackendId,
  type RelatedRerankResult,
} from "./related-ranker";
import {
  relatedJudgedSetSchema,
  type RelatedJudgedSet,
} from "./judged-benchmark";

const relatedFacetSchema = z.enum([
  "topic",
  "methodology",
  "evaluation",
  "lineage",
  "alternative",
  "systems",
  "resource",
  "citation",
  "other",
]);

const relatedTrainingSplitSchema = z.enum(["train", "dev"]);
const relatedLabelSourceSchema = z.enum([
  "judged",
  "weak_relation",
  "hard_negative",
]);
const relatedLabelStrengthSchema = z.enum(["gold", "silver", "bronze"]);

const relatedTrainingPaperSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1).nullable(),
  title: z.string().min(1),
  abstract: z.string().nullable(),
  summary: z.string().nullable(),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  citationCount: z.number().int().nullable(),
});

const relatedTrainingFeatureSchema = z.object({
  baselineConfidence: z.number(),
  rerankScore: z.number(),
  semanticSimilarity: z.number(),
  titleSimilarity: z.number(),
  queryTitleOverlap: z.number(),
  queryTitleOverlapCount: z.number().int().nonnegative(),
  bodyTokenOverlap: z.number(),
  tagOverlap: z.number(),
  lexicalAuthorOverlap: z.number(),
  identityAuthorOverlap: z.number(),
  venueOverlap: z.number(),
  yearProximity: z.number(),
  hubScore: z.number(),
  citationPrior: z.number(),
  relationTypePrior: z.number(),
  deterministicSignals: z.object({
    directCitation: z.number(),
    reverseCitation: z.number(),
    bibliographicCoupling: z.number(),
    coCitation: z.number(),
    titleSimilarity: z.number(),
  }),
  baselineRank: z.number().int().positive().nullable(),
  rerankedRank: z.number().int().positive().nullable(),
  inBaseline: z.boolean(),
  inReranked: z.boolean(),
});

const relatedTrainingLabelSchema = z.object({
  relevance: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  facets: z.array(relatedFacetSchema),
  subtopics: z.array(z.string()),
  source: relatedLabelSourceSchema,
  strength: relatedLabelStrengthSchema,
  relationTypes: z.array(z.string()),
  rationale: z.string().nullable(),
});

export const relatedTrainingPairSchema = z.object({
  id: z.string().min(1),
  pairKey: z.string().min(1),
  split: relatedTrainingSplitSchema,
  seedCaseId: z.string().nullable(),
  seedPaper: relatedTrainingPaperSchema,
  candidatePaper: relatedTrainingPaperSchema,
  label: relatedTrainingLabelSchema,
  features: relatedTrainingFeatureSchema,
  provenance: z.object({
    backendId: z.string().min(1),
    judgedCaseClass: z.string().nullable(),
    candidateRankSource: z.enum(["baseline", "reranked", "unranked"]),
  }),
});

export const relatedTrainingCaseSchema = z.object({
  id: z.string().min(1),
  split: relatedTrainingSplitSchema,
  caseClass: z.string().nullable(),
  seedPaper: relatedTrainingPaperSchema,
  pairs: z.array(relatedTrainingPairSchema),
});

export const relatedTrainingCorpusSchema = z.object({
  task: z.literal("related-papers-training"),
  version: z.string().min(1),
  generatedAt: z.string().min(1),
  backendId: z.string().min(1),
  judgedSplit: z.string().min(1),
  trainPairs: z.array(relatedTrainingPairSchema),
  devPairs: z.array(relatedTrainingPairSchema),
  trainCases: z.array(relatedTrainingCaseSchema),
  devCases: z.array(relatedTrainingCaseSchema),
  summary: z.object({
    totalPairs: z.number().int().nonnegative(),
    trainPairCount: z.number().int().nonnegative(),
    devPairCount: z.number().int().nonnegative(),
    bySource: z.record(z.string(), z.number().int().nonnegative()),
    byFacet: z.record(z.string(), z.number().int().nonnegative()),
    judgedUnresolvedCount: z.number().int().nonnegative(),
    weakSeedCount: z.number().int().nonnegative(),
  }),
});

export type RelatedFacet = z.infer<typeof relatedFacetSchema>;
export type RelatedLabelSource = z.infer<typeof relatedLabelSourceSchema>;
export type RelatedLabelStrength = z.infer<typeof relatedLabelStrengthSchema>;
export type RelatedTrainingPaper = z.infer<typeof relatedTrainingPaperSchema>;
export type RelatedTrainingFeature = z.infer<typeof relatedTrainingFeatureSchema>;
export type RelatedTrainingLabel = z.infer<typeof relatedTrainingLabelSchema>;
export type RelatedTrainingPair = z.infer<typeof relatedTrainingPairSchema>;
export type RelatedTrainingCase = z.infer<typeof relatedTrainingCaseSchema>;
export type RelatedTrainingCorpus = z.infer<typeof relatedTrainingCorpusSchema>;

export interface BuildRelatedTrainingCorpusOptions {
  judgedSet: RelatedJudgedSet;
  backendId?: RelatedRerankerBackendId;
  trainSeedLimit?: number;
  maxWeakPositivesPerSeed?: number;
  maxHardNegativesPerSeed?: number;
}

type RelatedTrainingDb = Pick<
  typeof prisma,
  "paper" | "paperRelation" | "relationAssertion" | "paperRepresentation"
>;

const RELATED_TRAINING_VERSION = "related_training_v1";
const RELATED_TRAINING_PAPER_SELECT = {
  id: true,
  userId: true,
  entityId: true,
  title: true,
  abstract: true,
  summary: true,
  authors: true,
  year: true,
  venue: true,
  doi: true,
  arxivId: true,
  citationCount: true,
} as const;

type SelectedTrainingPaper = {
  id: string;
  userId: string | null;
  entityId: string | null;
  title: string;
  abstract: string | null;
  summary: string | null;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  citationCount: number | null;
};

const FACET_PATTERNS: Array<[RegExp, RelatedFacet[]]> = [
  [/same paper|identical paper|duplicate/i, ["other"]],
  [/addresses same problem|same problem|same task|same domain/i, ["topic"]],
  [/related methodology|same methodology|same method|extends methodology/i, ["methodology"]],
  [/same evaluation|same dataset|uses same dataset|evaluation/i, ["evaluation"]],
  [/builds upon|extends|foundation/i, ["lineage"]],
  [/competing approach|alternative|contradict/i, ["alternative"]],
  [/inference|serving|systems|throughput|memory|latency|edge/i, ["systems"]],
  [/survey|review|benchmark|leaderboard/i, ["resource"]],
  [/cites/i, ["citation"]],
];

function round(value: number): number {
  return Number(value.toFixed(6));
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
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

export function mapRelationTypeToFacets(
  relationType: string,
  description?: string | null,
): RelatedFacet[] {
  const haystack = `${relationType} ${description ?? ""}`;
  for (const [pattern, facets] of FACET_PATTERNS) {
    if (pattern.test(haystack)) {
      return facets;
    }
  }
  return ["other"];
}

export function deriveWeakRelationRelevance(
  relationType: string,
  confidence: number,
): 1 | 2 {
  if (/addresses same problem|builds upon|competing approach|alternative/i.test(relationType)) {
    return confidence >= 0.5 ? 2 : 1;
  }

  if (/related methodology|same methodology|same method|same evaluation|same dataset/i.test(relationType)) {
    return confidence >= 0.7 ? 2 : 1;
  }

  return confidence >= 0.8 ? 2 : 1;
}

export function isHardNegativeCandidate(
  diagnostics: RelatedRerankCandidateDiagnostics,
): boolean {
  if (diagnostics.rerankScore < 0.12) return false;
  return (
    diagnostics.semanticSimilarity >= 0.2 ||
    diagnostics.queryTitleOverlap >= 0.15 ||
    diagnostics.bodyTokenOverlap >= 0.12 ||
    diagnostics.tagOverlap >= 0.15 ||
    diagnostics.titleSimilarity >= 0.18
  );
}

function toTrainingPaper(row: SelectedTrainingPaper): RelatedTrainingPaper {
  return {
    id: row.id,
    entityId: row.entityId,
    title: row.title,
    abstract: row.abstract,
    summary: row.summary,
    authors: parseStringArray(row.authors),
    year: row.year,
    venue: row.venue,
    doi: row.doi,
    arxivId: row.arxivId,
    citationCount: row.citationCount,
  };
}

function buildFeatureMap(
  rerankResult: RelatedRerankResult,
): Map<
  string,
  {
    diagnostics: RelatedRerankCandidateDiagnostics | null;
    baselineRank: number | null;
    rerankedRank: number | null;
  }
> {
  const map = new Map<
    string,
    {
      diagnostics: RelatedRerankCandidateDiagnostics | null;
      baselineRank: number | null;
      rerankedRank: number | null;
    }
  >();

  for (let index = 0; index < rerankResult.baselineRows.length; index += 1) {
    const row = rerankResult.baselineRows[index];
    const current = map.get(row.relatedPaper.id);
    map.set(row.relatedPaper.id, {
      diagnostics: current?.diagnostics ?? null,
      baselineRank: index + 1,
      rerankedRank: current?.rerankedRank ?? null,
    });
  }

  for (let index = 0; index < rerankResult.rerankedRows.length; index += 1) {
    const row = rerankResult.rerankedRows[index];
    const current = map.get(row.relatedPaper.id);
    map.set(row.relatedPaper.id, {
      diagnostics: current?.diagnostics ?? null,
      baselineRank: current?.baselineRank ?? null,
      rerankedRank: index + 1,
    });
  }

  for (const diagnostics of rerankResult.diagnostics) {
    const current = map.get(diagnostics.paperId);
    map.set(diagnostics.paperId, {
      diagnostics,
      baselineRank: current?.baselineRank ?? null,
      rerankedRank: current?.rerankedRank ?? null,
    });
  }

  return map;
}

function buildTrainingFeatures(
  featureState:
    | {
        diagnostics: RelatedRerankCandidateDiagnostics | null;
        baselineRank: number | null;
        rerankedRank: number | null;
      }
    | undefined,
): RelatedTrainingFeature {
  const diagnostics = featureState?.diagnostics;
  return {
    baselineConfidence: round(diagnostics?.baselineConfidence ?? 0),
    rerankScore: round(diagnostics?.rerankScore ?? 0),
    semanticSimilarity: round(diagnostics?.semanticSimilarity ?? 0),
    titleSimilarity: round(diagnostics?.titleSimilarity ?? 0),
    queryTitleOverlap: round(diagnostics?.queryTitleOverlap ?? 0),
    queryTitleOverlapCount: diagnostics?.queryTitleOverlapCount ?? 0,
    bodyTokenOverlap: round(diagnostics?.bodyTokenOverlap ?? 0),
    tagOverlap: round(diagnostics?.tagOverlap ?? 0),
    lexicalAuthorOverlap: round(diagnostics?.lexicalAuthorOverlap ?? 0),
    identityAuthorOverlap: round(diagnostics?.identityAuthorOverlap ?? 0),
    venueOverlap: round(diagnostics?.venueOverlap ?? 0),
    yearProximity: round(diagnostics?.yearProximity ?? 0),
    hubScore: round(diagnostics?.hubScore ?? 0),
    citationPrior: round(diagnostics?.citationPrior ?? 0),
    relationTypePrior: round(diagnostics?.relationTypePrior ?? 0),
    deterministicSignals: {
      directCitation: round(diagnostics?.deterministicSignals.direct_citation ?? 0),
      reverseCitation: round(diagnostics?.deterministicSignals.reverse_citation ?? 0),
      bibliographicCoupling: round(
        diagnostics?.deterministicSignals.bibliographic_coupling ?? 0,
      ),
      coCitation: round(diagnostics?.deterministicSignals.co_citation ?? 0),
      titleSimilarity: round(diagnostics?.deterministicSignals.title_similarity ?? 0),
    },
    baselineRank: featureState?.baselineRank ?? null,
    rerankedRank: featureState?.rerankedRank ?? null,
    inBaseline: featureState?.baselineRank != null,
    inReranked: featureState?.rerankedRank != null,
  };
}

async function resolvePaperLocator(
  locator: { title: string; doi?: string; arxivId?: string },
  userId: string,
  db: RelatedTrainingDb,
): Promise<SelectedTrainingPaper | null> {
  const orClauses: Array<{ doi: string } | { arxivId: string } | { title: string }> = [];
  if (locator.doi) orClauses.push({ doi: locator.doi });
  if (locator.arxivId) orClauses.push({ arxivId: locator.arxivId });
  orClauses.push({ title: locator.title });

  const paper = await db.paper.findFirst({
    where: {
      userId,
      duplicateState: "ACTIVE",
      OR: orClauses,
    },
    select: RELATED_TRAINING_PAPER_SELECT,
  });

  return paper as SelectedTrainingPaper | null;
}

async function findDefaultUserId(
  judgedSet: RelatedJudgedSet,
  db: RelatedTrainingDb,
): Promise<string> {
  for (const caseEntry of judgedSet.cases) {
    const paper = await db.paper.findFirst({
      where: {
        duplicateState: "ACTIVE",
        OR: [
          caseEntry.seed.doi ? { doi: caseEntry.seed.doi } : undefined,
          caseEntry.seed.arxivId ? { arxivId: caseEntry.seed.arxivId } : undefined,
          { title: caseEntry.seed.title },
        ].filter(Boolean) as Array<{ doi: string } | { arxivId: string } | { title: string }>,
      },
      select: { userId: true },
    });
    if (paper?.userId) return paper.userId;
  }

  const fallback = await db.paper.findFirst({
    where: {
      userId: { not: null },
      duplicateState: "ACTIVE",
    },
    select: { userId: true },
    orderBy: [{ citationCount: "desc" }, { createdAt: "asc" }],
  });

  if (!fallback?.userId) {
    throw new Error("Unable to resolve a user for related training corpus generation");
  }

  return fallback.userId;
}

async function loadPaperMap(
  paperIds: string[],
  db: RelatedTrainingDb,
): Promise<Map<string, SelectedTrainingPaper>> {
  if (paperIds.length === 0) return new Map();
  const rows = await db.paper.findMany({
    where: { id: { in: paperIds } },
    select: RELATED_TRAINING_PAPER_SELECT,
  });

  return new Map(
    (rows as SelectedTrainingPaper[]).map((row) => [row.id, row]),
  );
}

function createPairId(
  split: "train" | "dev",
  seedPaperId: string,
  candidatePaperId: string,
): string {
  return `related-${split}-${seedPaperId}-${candidatePaperId}`;
}

function toPairKey(seedPaperId: string, candidatePaperId: string): string {
  return `${seedPaperId}::${candidatePaperId}`;
}

function pickCandidateRankSource(features: RelatedTrainingFeature): "baseline" | "reranked" | "unranked" {
  if (features.rerankedRank != null) return "reranked";
  if (features.baselineRank != null) return "baseline";
  return "unranked";
}

function buildPair(params: {
  split: "train" | "dev";
  seedCaseId: string | null;
  seedCaseClass: string | null;
  backendId: RelatedRerankerBackendId;
  seedPaper: SelectedTrainingPaper;
  candidatePaper: SelectedTrainingPaper;
  label: RelatedTrainingLabel;
  featureState:
    | {
        diagnostics: RelatedRerankCandidateDiagnostics | null;
        baselineRank: number | null;
        rerankedRank: number | null;
      }
    | undefined;
}): RelatedTrainingPair {
  const features = buildTrainingFeatures(params.featureState);
  return {
    id: createPairId(params.split, params.seedPaper.id, params.candidatePaper.id),
    pairKey: toPairKey(params.seedPaper.id, params.candidatePaper.id),
    split: params.split,
    seedCaseId: params.seedCaseId,
    seedPaper: toTrainingPaper(params.seedPaper),
    candidatePaper: toTrainingPaper(params.candidatePaper),
    label: params.label,
    features,
    provenance: {
      backendId: params.backendId,
      judgedCaseClass: params.seedCaseClass,
      candidateRankSource: pickCandidateRankSource(features),
    },
  };
}

function buildCase(
  id: string,
  split: "train" | "dev",
  caseClass: string | null,
  seedPaper: SelectedTrainingPaper,
  pairs: RelatedTrainingPair[],
): RelatedTrainingCase {
  return {
    id,
    split,
    caseClass,
    seedPaper: toTrainingPaper(seedPaper),
    pairs,
  };
}

async function buildRerankState(
  seedPaper: SelectedTrainingPaper,
  userId: string,
  backendId: RelatedRerankerBackendId,
  db: RelatedTrainingDb,
): Promise<{
  rerankResult: RelatedRerankResult;
  featureMap: Map<
    string,
    {
      diagnostics: RelatedRerankCandidateDiagnostics | null;
      baselineRank: number | null;
      rerankedRank: number | null;
    }
  >;
}> {
  const relationResult = await listRelationsForPaper(seedPaper.id, userId, db);
  const baselineRows = relationResult.mode === "legacy_fallback"
    ? relationResult.legacyRows
    : [...relationResult.aggregateRows, ...relationResult.overlayRows];
  const rerankResult = await buildRelatedRerankResult(
    seedPaper.id,
    userId,
    baselineRows,
    db,
    { backendId } satisfies BuildRelatedRerankOptions,
  );

  return {
    rerankResult,
    featureMap: buildFeatureMap(rerankResult),
  };
}

async function buildDevCases(
  judgedSet: RelatedJudgedSet,
  userId: string,
  backendId: RelatedRerankerBackendId,
  db: RelatedTrainingDb,
): Promise<{
  devCases: RelatedTrainingCase[];
  devPairs: RelatedTrainingPair[];
  unresolvedCount: number;
  devSeedIds: Set<string>;
  devPairKeys: Set<string>;
}> {
  const devCases: RelatedTrainingCase[] = [];
  const devPairs: RelatedTrainingPair[] = [];
  const devSeedIds = new Set<string>();
  const devPairKeys = new Set<string>();
  let unresolvedCount = 0;

  for (const caseEntry of judgedSet.cases) {
    const seedPaper = await resolvePaperLocator(caseEntry.seed, userId, db);
    if (!seedPaper) {
      unresolvedCount += caseEntry.judgments.length + 1;
      continue;
    }

    devSeedIds.add(seedPaper.id);
    const { featureMap } = await buildRerankState(seedPaper, userId, backendId, db);
    const pairs: RelatedTrainingPair[] = [];

    for (const label of caseEntry.judgments) {
      const candidatePaper = await resolvePaperLocator(label, userId, db);
      if (!candidatePaper) {
        unresolvedCount += 1;
        continue;
      }

      const pair = buildPair({
        split: "dev",
        seedCaseId: caseEntry.id,
        seedCaseClass: caseEntry.caseClass,
        backendId,
        seedPaper,
        candidatePaper,
        label: {
          relevance: label.relevance,
          facets: [],
          subtopics: label.subtopics,
          source: "judged",
          strength: "gold",
          relationTypes: [],
          rationale: label.notes ?? caseEntry.notes ?? null,
        },
        featureState: featureMap.get(candidatePaper.id),
      });
      pairs.push(pair);
      devPairs.push(pair);
      devPairKeys.add(pair.pairKey);
    }

    if (pairs.length > 0) {
      devCases.push(buildCase(caseEntry.id, "dev", caseEntry.caseClass, seedPaper, pairs));
    }
  }

  return { devCases, devPairs, unresolvedCount, devSeedIds, devPairKeys };
}

async function buildWeakTrainCases(
  params: {
    userId: string;
    backendId: RelatedRerankerBackendId;
    devSeedIds: Set<string>;
    devPairKeys: Set<string>;
    trainSeedLimit: number;
    maxWeakPositivesPerSeed: number;
    maxHardNegativesPerSeed: number;
  },
  db: RelatedTrainingDb,
): Promise<{ trainCases: RelatedTrainingCase[]; trainPairs: RelatedTrainingPair[]; weakSeedCount: number }> {
  const seedRows = (await db.paper.findMany({
    where: {
      userId: params.userId,
      duplicateState: "ACTIVE",
      entityId: { not: null },
      id: { notIn: Array.from(params.devSeedIds) },
    },
    select: RELATED_TRAINING_PAPER_SELECT,
    orderBy: [{ citationCount: "desc" }, { createdAt: "desc" }],
    take: params.trainSeedLimit,
  })) as SelectedTrainingPaper[];

  const trainCases: RelatedTrainingCase[] = [];
  const trainPairs: RelatedTrainingPair[] = [];
  let weakSeedCount = 0;

  for (const seedPaper of seedRows) {
    const { rerankResult, featureMap } = await buildRerankState(
      seedPaper,
      params.userId,
      params.backendId,
      db,
    );

    const positiveRows = rerankResult.rerankedRows
      .filter((row) => !/^cites$/i.test(row.relationType))
      .filter((row) => !/same paper|duplicate/i.test(row.relationType))
      .filter((row) => {
        const facets = mapRelationTypeToFacets(row.relationType, row.description);
        return !facets.includes("citation") && !facets.includes("other");
      })
      .slice(0, params.maxWeakPositivesPerSeed);

    if (positiveRows.length === 0) continue;

    const positiveIds = new Set(positiveRows.map((row) => row.relatedPaper.id));
    const negativeDiagnostics = rerankResult.diagnostics
      .filter((diagnostics) => !positiveIds.has(diagnostics.paperId))
      .filter(isHardNegativeCandidate)
      .slice(0, params.maxHardNegativesPerSeed);

    const candidatePaperIds = stableUnique([
      ...positiveRows.map((row) => row.relatedPaper.id),
      ...negativeDiagnostics.map((diagnostics) => diagnostics.paperId),
    ]);
    const paperMap = await loadPaperMap(candidatePaperIds, db);

    const pairs: RelatedTrainingPair[] = [];
    for (const row of positiveRows) {
      const candidatePaper = paperMap.get(row.relatedPaper.id);
      if (!candidatePaper) continue;
      const pairKey = toPairKey(seedPaper.id, candidatePaper.id);
      if (params.devPairKeys.has(pairKey)) continue;
      const facets = mapRelationTypeToFacets(row.relationType, row.description);
      const pair = buildPair({
        split: "train",
        seedCaseId: null,
        seedCaseClass: null,
        backendId: params.backendId,
        seedPaper,
        candidatePaper,
        label: {
          relevance: deriveWeakRelationRelevance(row.relationType, row.confidence),
          facets,
          subtopics: [],
          source: "weak_relation",
          strength: row.confidence >= 0.65 ? "silver" : "bronze",
          relationTypes: [row.relationType],
          rationale: row.description ?? null,
        },
        featureState: featureMap.get(candidatePaper.id),
      });
      pairs.push(pair);
      trainPairs.push(pair);
    }

    for (const diagnostics of negativeDiagnostics) {
      const candidatePaper = paperMap.get(diagnostics.paperId);
      if (!candidatePaper) continue;
      const pairKey = toPairKey(seedPaper.id, candidatePaper.id);
      if (params.devPairKeys.has(pairKey)) continue;
      const pair = buildPair({
        split: "train",
        seedCaseId: null,
        seedCaseClass: null,
        backendId: params.backendId,
        seedPaper,
        candidatePaper,
        label: {
          relevance: 0,
          facets: [],
          subtopics: [],
          source: "hard_negative",
          strength: "bronze",
          relationTypes: [],
          rationale: "High-scoring retrieved candidate not supported by judged or assertion-derived relatedness.",
        },
        featureState: featureMap.get(candidatePaper.id),
      });
      pairs.push(pair);
      trainPairs.push(pair);
    }

    if (pairs.length > 0) {
      weakSeedCount += 1;
      trainCases.push(buildCase(`weak-${seedPaper.id}`, "train", null, seedPaper, pairs));
    }
  }

  return { trainCases, trainPairs, weakSeedCount };
}

function summarizeCorpus(corpus: {
  trainPairs: RelatedTrainingPair[];
  devPairs: RelatedTrainingPair[];
  unresolvedCount: number;
  weakSeedCount: number;
}) {
  const bySource = new Map<string, number>();
  const byFacet = new Map<string, number>();

  for (const pair of [...corpus.trainPairs, ...corpus.devPairs]) {
    bySource.set(pair.label.source, (bySource.get(pair.label.source) ?? 0) + 1);
    for (const facet of pair.label.facets) {
      byFacet.set(facet, (byFacet.get(facet) ?? 0) + 1);
    }
  }

  return {
    totalPairs: corpus.trainPairs.length + corpus.devPairs.length,
    trainPairCount: corpus.trainPairs.length,
    devPairCount: corpus.devPairs.length,
    bySource: Object.fromEntries(Array.from(bySource.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    byFacet: Object.fromEntries(Array.from(byFacet.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    judgedUnresolvedCount: corpus.unresolvedCount,
    weakSeedCount: corpus.weakSeedCount,
  };
}

export async function buildRelatedTrainingCorpus(
  options: BuildRelatedTrainingCorpusOptions,
  db: RelatedTrainingDb = prisma,
): Promise<RelatedTrainingCorpus> {
  const judgedSet = relatedJudgedSetSchema.parse(options.judgedSet);
  const backendId = options.backendId ?? "feature_v1";
  const userId = await findDefaultUserId(judgedSet, db);

  const {
    devCases,
    devPairs,
    unresolvedCount,
    devSeedIds,
    devPairKeys,
  } = await buildDevCases(judgedSet, userId, backendId, db);

  const {
    trainCases,
    trainPairs,
    weakSeedCount,
  } = await buildWeakTrainCases(
    {
      userId,
      backendId,
      devSeedIds,
      devPairKeys,
      trainSeedLimit: options.trainSeedLimit ?? 400,
      maxWeakPositivesPerSeed: options.maxWeakPositivesPerSeed ?? 6,
      maxHardNegativesPerSeed: options.maxHardNegativesPerSeed ?? 8,
    },
    db,
  );

  return relatedTrainingCorpusSchema.parse({
    task: "related-papers-training",
    version: RELATED_TRAINING_VERSION,
    generatedAt: new Date().toISOString(),
    backendId,
    judgedSplit: judgedSet.split,
    trainPairs,
    devPairs,
    trainCases,
    devCases,
    summary: summarizeCorpus({
      trainPairs,
      devPairs,
      unresolvedCount,
      weakSeedCount,
    }),
  });
}

export function parseRelatedTrainingCorpus(
  value: unknown,
): RelatedTrainingCorpus {
  return relatedTrainingCorpusSchema.parse(value);
}

export const RELATED_BATCH_LABEL_TASK = "related-papers-llm-labeling";

export const relatedBatchLabelPromptSchema = z.object({
  seedPaper: relatedTrainingPaperSchema,
  candidatePaper: relatedTrainingPaperSchema,
  existingLabel: relatedTrainingLabelSchema.optional(),
  features: relatedTrainingFeatureSchema,
});

export type RelatedBatchLabelPrompt = z.infer<typeof relatedBatchLabelPromptSchema>;

export function buildRelatedBatchLabelPayload(
  pair: RelatedTrainingPair,
): RelatedBatchLabelPrompt {
  return relatedBatchLabelPromptSchema.parse({
    seedPaper: pair.seedPaper,
    candidatePaper: pair.candidatePaper,
    existingLabel:
      pair.label.source === "judged" ? pair.label : undefined,
    features: pair.features,
  });
}
