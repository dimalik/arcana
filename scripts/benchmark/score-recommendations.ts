import fs from "fs";
import path from "path";

import { prisma } from "@/lib/prisma";
import { getRecommendationsForSeedPapers } from "@/lib/recommendations/engine";
import {
  buildSharedPaperFeatureDocument,
  cosineSimilarity,
  encodeFeatureSectionsToVector,
} from "@/lib/papers/retrieval";
import {
  benchmarkBudgetsSchema,
  benchmarkFloorsSchema,
  recommendationsJudgedSetSchema,
  type JudgedLabel,
} from "@/lib/papers/retrieval/judged-benchmark";
import type { RecommendedPaper } from "@/lib/recommendations/types";

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6),
  );
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function flagEnabled(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function discount(rank: number): number {
  return 1 / Math.log2(rank + 2);
}

function dcg(relevances: number[], limit: number): number {
  return round(
    relevances
      .slice(0, limit)
      .reduce((sum, relevance, index) => sum + (2 ** relevance - 1) * discount(index), 0),
  );
}

function ndcgAtK(relevances: number[], idealRelevances: number[], limit: number): number {
  const ideal = dcg(idealRelevances, limit);
  if (ideal <= 0) return 0;
  return round(dcg(relevances, limit) / ideal);
}

function noveltyAtK(
  retrievedTitles: string[],
  labelMap: Map<string, JudgedLabel>,
  limit: number,
): number {
  const values = retrievedTitles
    .slice(0, limit)
    .map((title) => labelMap.get(title)?.novelty ?? 0);
  return average(values);
}

function subtopicCoverageAtK(
  retrievedTitles: string[],
  labelMap: Map<string, JudgedLabel>,
  limit: number,
): number {
  const totalSubtopics = new Set(
    Array.from(labelMap.values())
      .filter((label) => label.relevance > 0)
      .flatMap((label) => label.subtopics),
  );
  if (totalSubtopics.size === 0) return 0;

  const covered = new Set<string>();
  for (const title of retrievedTitles.slice(0, limit)) {
    const label = labelMap.get(title);
    if (!label || label.relevance <= 0) continue;
    for (const subtopic of label.subtopics) {
      covered.add(subtopic);
    }
  }

  return round(covered.size / totalSubtopics.size);
}

function buildPaperVector(paper: RecommendedPaper): number[] {
  const featureDocument = buildSharedPaperFeatureDocument({
    title: paper.title,
    abstract: paper.abstract,
    summary: paper.matchReason ?? null,
    keyFindings: null,
    authors: JSON.stringify(paper.authors),
    venue: null,
    year: paper.year,
    tags: [],
    claims: [],
  });
  return encodeFeatureSectionsToVector(featureDocument.sections);
}

function ilsAtK(papers: RecommendedPaper[], limit: number): number {
  const vectors = papers.slice(0, limit).map(buildPaperVector);
  if (vectors.length < 2) return 0;

  const similarities: number[] = [];
  for (let index = 0; index < vectors.length; index += 1) {
    for (let peerIndex = index + 1; peerIndex < vectors.length; peerIndex += 1) {
      similarities.push(cosineSimilarity(vectors[index], vectors[peerIndex]));
    }
  }

  return average(similarities);
}

function metricOrientation(metric: string): "min" | "max" {
  return metric.toLowerCase().includes("ils") ? "min" : "max";
}

function compareToFloor(metric: string, value: number, floor: number | null): boolean | null {
  if (floor == null) return null;
  return metricOrientation(metric) === "min" ? value <= floor : value >= floor;
}

async function resolveUserId(): Promise<string> {
  const owner = await prisma.paper.findFirst({
    where: { userId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });

  if (!owner?.userId) {
    throw new Error("Unable to resolve a paper-owning user for recommendations benchmark");
  }

  return owner.userId;
}

async function resolveSeedPaperIds(
  userId: string,
  seeds: Array<{ title: string; doi?: string; arxivId?: string }>,
): Promise<string[]> {
  const paperIds: string[] = [];

  for (const seed of seeds) {
    const paper = await prisma.paper.findFirst({
      where: mergeSeedLocator(userId, seed),
      select: { id: true },
    });
    if (!paper) {
      throw new Error(`Unable to resolve recommendation seed paper: ${seed.title}`);
    }
    paperIds.push(paper.id);
  }

  return paperIds;
}

function mergeSeedLocator(
  userId: string,
  locator: { title: string; doi?: string; arxivId?: string },
) {
  const orClauses: Array<{ title: string } | { doi: string } | { arxivId: string }> = [];
  if (locator.doi) orClauses.push({ doi: locator.doi });
  if (locator.arxivId) orClauses.push({ arxivId: locator.arxivId });
  orClauses.push({ title: locator.title });

  return {
    userId,
    duplicateState: "ACTIVE" as const,
    OR: orClauses,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const localOnly =
    flagEnabled(argv, "--local-only")
    || process.env.ARCANA_RECOMMENDATIONS_BENCHMARK_LOCAL_ONLY === "1";
  const outPath = path.join(
    process.cwd(),
    "benchmark",
    "scored",
    localOnly
      ? "recommendations.dev.local-only.scored.json"
      : "recommendations.dev.scored.json",
  );

  const userId = await resolveUserId();
  const judgedSet = recommendationsJudgedSetSchema.parse(
    JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "benchmark", "judged", "recommendations.dev.judged.json"),
        "utf8",
      ),
    ),
  );
  const budgets = benchmarkBudgetsSchema.parse(
    JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "benchmark", "budgets.json"), "utf8"),
    ),
  );
  const floors = benchmarkFloorsSchema.parse(
    JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "benchmark", "floors.json"), "utf8"),
    ),
  );

  const caseResults = [];

  for (const caseEntry of judgedSet.cases) {
    const seedPaperIds = await resolveSeedPaperIds(userId, caseEntry.seedPapers);
    const startedAt = performance.now();
    const recommendations = await getRecommendationsForSeedPapers({
      userId,
      paperIds: seedPaperIds,
      profileDescription: caseEntry.profileDescription,
      options: {
        includeExternalSources: !localOnly,
        allowLibraryCandidates: localOnly,
      },
    });
    const elapsedMs = round(performance.now() - startedAt);

    const labelMap = new Map(caseEntry.judgments.map((label) => [label.title, label]));
    const idealRelevances = [...caseEntry.judgments]
      .map((label) => label.relevance)
      .sort((left, right) => right - left);
    const retrievedTitles = recommendations.recommended.map((paper) => paper.title);
    const relevances = retrievedTitles.map(
      (title) => labelMap.get(title)?.relevance ?? 0,
    );

    caseResults.push({
      id: caseEntry.id,
      caseClass: caseEntry.caseClass,
      profileDescription: caseEntry.profileDescription,
      latencyMs: elapsedMs,
      budgetPass: elapsedMs <= budgets.recommendations.readP95Ms,
      metrics: {
        ndcgAt10: ndcgAtK(relevances, idealRelevances, 10),
        noveltyAt10: noveltyAtK(retrievedTitles, labelMap, 10),
        ilsAt10: ilsAtK(recommendations.recommended, 10),
        subtopicCoverageAt10: subtopicCoverageAtK(retrievedTitles, labelMap, 10),
      },
      recommendedTop10: recommendations.recommended.slice(0, 10).map((paper) => ({
        title: paper.title,
        source: paper.source,
        matchReason: paper.matchReason ?? null,
      })),
      latestTop10: recommendations.latest.slice(0, 10).map((paper) => ({
        title: paper.title,
        source: paper.source,
        matchReason: paper.matchReason ?? null,
      })),
    });
  }

  const summary = {
    task: "recommendations",
    split: "dev",
    retrievalConfig: {
      localOnly,
      internalProfileRetrieval: true,
      externalSources: localOnly
        ? []
        : ["semantic-scholar", "arxiv", "keyword-search"],
      rerankerFamily: "recommendation_feature_reranker_v1",
      diversificationStage: "shared_recommendations_diversify_high_lambda",
    },
    budgets: budgets.recommendations,
    floors: floors.tasks.recommendations.dev,
    metrics: {
      ndcgAt10: average(caseResults.map((caseResult) => caseResult.metrics.ndcgAt10)),
      noveltyAt10: average(caseResults.map((caseResult) => caseResult.metrics.noveltyAt10)),
      ilsAt10: average(caseResults.map((caseResult) => caseResult.metrics.ilsAt10)),
      subtopicCoverageAt10: average(
        caseResults.map((caseResult) => caseResult.metrics.subtopicCoverageAt10),
      ),
    },
    latencyP95Ms: round(
      [...caseResults].sort((left, right) => left.latencyMs - right.latencyMs)[
        Math.max(0, Math.ceil(caseResults.length * 0.95) - 1)
      ]?.latencyMs ?? 0,
    ),
    costP95UsdPerUserDay: 0,
    floorChecks: {
      ndcgAt10: compareToFloor(
        "ndcgAt10",
        average(caseResults.map((caseResult) => caseResult.metrics.ndcgAt10)),
        floors.tasks.recommendations.dev.ndcgAt10,
      ),
      noveltyAt10: compareToFloor(
        "noveltyAt10",
        average(caseResults.map((caseResult) => caseResult.metrics.noveltyAt10)),
        floors.tasks.recommendations.dev.noveltyAt10,
      ),
      ilsAt10: compareToFloor(
        "ilsAt10",
        average(caseResults.map((caseResult) => caseResult.metrics.ilsAt10)),
        floors.tasks.recommendations.dev.ilsAt10,
      ),
      subtopicCoverageAt10: compareToFloor(
        "subtopicCoverageAt10",
        average(caseResults.map((caseResult) => caseResult.metrics.subtopicCoverageAt10)),
        floors.tasks.recommendations.dev.subtopicCoverageAt10,
      ),
    },
    cases: caseResults,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[score-recommendations] Failed:", error);
  process.exit(1);
});
