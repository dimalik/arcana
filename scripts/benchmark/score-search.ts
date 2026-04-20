import fs from "fs";
import path from "path";

import { prisma } from "@/lib/prisma";
import { mergePaperVisibilityWhere } from "@/lib/papers/visibility";
import { searchLibraryPapers } from "@/lib/papers/search";
import {
  benchmarkBudgetsSchema,
  benchmarkFloorsSchema,
  searchJudgedSetSchema,
  type JudgedLabel,
} from "@/lib/papers/retrieval/judged-benchmark";
import { SHARED_RAW_PAPER_REPRESENTATION_KIND } from "@/lib/papers/retrieval";

function valueFor(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6),
  );
}

function round(value: number): number {
  return Number(value.toFixed(6));
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

function recallAtK(retrievedTitles: string[], labelMap: Map<string, JudgedLabel>, limit: number): number {
  const relevantTitles = new Set(
    Array.from(labelMap.values())
      .filter((label) => label.relevance > 0)
      .map((label) => label.title),
  );
  if (relevantTitles.size === 0) return 0;
  const hits = retrievedTitles
    .slice(0, limit)
    .filter((title) => relevantTitles.has(title)).length;
  return round(hits / relevantTitles.size);
}

function mrrAtK(retrievedTitles: string[], labelMap: Map<string, JudgedLabel>, limit: number): number {
  for (let index = 0; index < Math.min(retrievedTitles.length, limit); index += 1) {
    const label = labelMap.get(retrievedTitles[index]);
    if (label && label.relevance > 0) {
      return round(1 / (index + 1));
    }
  }
  return 0;
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
    throw new Error("Unable to resolve a paper-owning user for search benchmark");
  }

  return owner.userId;
}

async function main() {
  const argv = process.argv.slice(2);
  const outPath =
    valueFor(argv, "--out")
    ?? path.join(process.cwd(), "benchmark", "scored", "search.dev.scored.json");

  const userId = await resolveUserId();
  const judgedSet = searchJudgedSetSchema.parse(
    JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "benchmark", "judged", "search.dev.judged.json"),
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
    const startedAt = performance.now();
    const result = await searchLibraryPapers({
      userId,
      queryText: caseEntry.query,
      where: mergePaperVisibilityWhere(userId, { isResearchOnly: false }),
      limit: 10,
      page: 1,
      sort: "newest",
    });
    const elapsedMs = round(performance.now() - startedAt);

    const labelMap = new Map(caseEntry.judgments.map((label) => [label.title, label]));
    const idealRelevances = [...caseEntry.judgments]
      .map((label) => label.relevance)
      .sort((left, right) => right - left);
    const retrievedTitles = result.papers.map((paper) => paper.title);
    const relevances = retrievedTitles.map((title) => labelMap.get(title)?.relevance ?? 0);

    caseResults.push({
      id: caseEntry.id,
      queryClass: caseEntry.queryClass,
      query: caseEntry.query,
      degraded: result.degraded,
      latencyMs: elapsedMs,
      budgetPass:
        elapsedMs <= budgets.search.apiP95Ms
        && result.papers.length <= budgets.search.candidateCap,
      metrics: {
        ndcgAt10: ndcgAtK(relevances, idealRelevances, 10),
        mrrAt10: mrrAtK(retrievedTitles, labelMap, 10),
        recallAt20: recallAtK(retrievedTitles, labelMap, 20),
      },
      top10: result.papers.map((paper) => ({
        id: paper.id,
        title: paper.title,
        matchFields: paper.matchFields,
        searchDiagnostics: paper.searchDiagnostics,
      })),
    });
  }

  const summary = {
    task: "search",
    split: "dev",
    retrievalConfig: {
      lexicalStages: [
        "doi_exact",
        "arxiv_exact",
        "title_phrase",
        "author_token",
        "tag_overlap",
        "body_text_contains_when_needed",
      ],
      semanticCandidateGeneration: {
        representationKind: SHARED_RAW_PAPER_REPRESENTATION_KIND,
        strategy: "conditional_shared_feature_hash_dense_retrieval",
        enabledWhen: "lexical_seed_count < 8 and query is not identifier/author/broad title",
      },
      rerankerFamily: "feature_reranker_v1",
      diversificationStage: "shared_search_diversify_low_lambda",
      costP95Usd: 0,
    },
    budgets: budgets.search,
    floors: floors.tasks.search.dev,
    metrics: {
      ndcgAt10: average(caseResults.map((caseResult) => caseResult.metrics.ndcgAt10)),
      mrrAt10: average(caseResults.map((caseResult) => caseResult.metrics.mrrAt10)),
      recallAt20: average(caseResults.map((caseResult) => caseResult.metrics.recallAt20)),
    },
    latencyP95Ms: round(
      [...caseResults].sort((left, right) => left.latencyMs - right.latencyMs)[
        Math.max(0, Math.ceil(caseResults.length * 0.95) - 1)
      ]?.latencyMs ?? 0,
    ),
    degraded: caseResults.some((caseResult) => caseResult.degraded),
    floorChecks: {
      ndcgAt10: compareToFloor(
        "ndcgAt10",
        average(caseResults.map((caseResult) => caseResult.metrics.ndcgAt10)),
        floors.tasks.search.dev.ndcgAt10,
      ),
      mrrAt10: compareToFloor(
        "mrrAt10",
        average(caseResults.map((caseResult) => caseResult.metrics.mrrAt10)),
        floors.tasks.search.dev.mrrAt10,
      ),
      recallAt20: compareToFloor(
        "recallAt20",
        average(caseResults.map((caseResult) => caseResult.metrics.recallAt20)),
        floors.tasks.search.dev.recallAt20,
      ),
    },
    caseResults,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[score-search] Failed:", error);
  process.exit(1);
});
