import fs from "fs";
import path from "path";

import { prisma } from "@/lib/prisma";
import { listRelationsForPaper } from "@/lib/assertions/relation-reader";
import { buildRelatedRerankResult } from "@/lib/papers/retrieval/related-ranker";
import {
  SHARED_RAW_PAPER_REPRESENTATION_KIND,
  cosineSimilarity,
  getPaperRepresentation,
} from "@/lib/papers/retrieval/embeddings";
import {
  benchmarkBudgetsSchema,
  benchmarkFloorsSchema,
  relatedJudgedSetSchema,
  type JudgedLabel,
} from "@/lib/papers/retrieval/judged-benchmark";

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

async function ilsAtK(
  retrievedPaperIds: string[],
  limit: number,
): Promise<number> {
  const topPaperIds = retrievedPaperIds.slice(0, limit);
  if (topPaperIds.length < 2) return 0;

  const vectors = new Map<string, number[]>();
  for (const paperId of topPaperIds) {
    const representation = await getPaperRepresentation(
      prisma,
      paperId,
      SHARED_RAW_PAPER_REPRESENTATION_KIND,
    );
    if (representation?.vector?.length) {
      vectors.set(paperId, representation.vector);
    }
  }

  const paperIds = Array.from(vectors.keys());
  if (paperIds.length < 2) return 0;

  const similarities: number[] = [];
  for (let index = 0; index < paperIds.length; index += 1) {
    for (let peerIndex = index + 1; peerIndex < paperIds.length; peerIndex += 1) {
      const left = vectors.get(paperIds[index]);
      const right = vectors.get(paperIds[peerIndex]);
      if (!left || !right) continue;
      similarities.push(cosineSimilarity(left, right));
    }
  }

  return average(similarities);
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

function metricOrientation(metric: string): "min" | "max" {
  return metric.toLowerCase().includes("ils") ? "min" : "max";
}

function compareToFloor(metric: string, value: number, floor: number | null): boolean | null {
  if (floor == null) return null;
  return metricOrientation(metric) === "min" ? value <= floor : value >= floor;
}

async function resolvePaper(locator: {
  title: string;
  doi?: string;
  arxivId?: string;
}) {
  const orClauses: Array<
    | { doi: string }
    | { arxivId: string }
    | { title: string }
  > = [];
  if (locator.doi) orClauses.push({ doi: locator.doi });
  if (locator.arxivId) orClauses.push({ arxivId: locator.arxivId });
  orClauses.push({ title: locator.title });

  return prisma.paper.findFirst({
    where: {
      userId: { not: null },
      OR: orClauses,
    },
    select: {
      id: true,
      userId: true,
      title: true,
    },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const outPath =
    valueFor(argv, "--out") ??
    path.join(process.cwd(), "benchmark", "scored", "related-papers.dev.scored.json");

  const judgedSet = relatedJudgedSetSchema.parse(
    JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "benchmark", "judged", "related-papers.dev.judged.json"),
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
    const seedPaper = await resolvePaper(caseEntry.seed);
    if (!seedPaper?.userId) {
      throw new Error(`Unable to resolve seed paper for case ${caseEntry.id}`);
    }

    const relationResult = await listRelationsForPaper(seedPaper.id, seedPaper.userId);
    const baselineInputRows =
      relationResult.mode === "legacy_fallback"
        ? relationResult.legacyRows
        : [...relationResult.aggregateRows, ...relationResult.overlayRows];

    const startedAt = performance.now();
    const rerankResult = await buildRelatedRerankResult(
      seedPaper.id,
      seedPaper.userId,
      baselineInputRows,
    );
    const elapsedMs = round(performance.now() - startedAt);

    const labelMap = new Map(caseEntry.judgments.map((label) => [label.title, label]));
    const idealRelevances = [...caseEntry.judgments]
      .map((label) => label.relevance)
      .sort((left, right) => right - left);

    const baselineTitles = rerankResult.baselineRows.map((row) => row.relatedPaper.title);
    const rerankedTitles = rerankResult.rerankedRows.map((row) => row.relatedPaper.title);
    const baselinePaperIds = rerankResult.baselineRows.map((row) => row.relatedPaper.id);
    const rerankedPaperIds = rerankResult.rerankedRows.map((row) => row.relatedPaper.id);

    const baselineRelevances = baselineTitles.map(
      (title) => labelMap.get(title)?.relevance ?? 0,
    );
    const rerankedRelevances = rerankedTitles.map(
      (title) => labelMap.get(title)?.relevance ?? 0,
    );

    const baselineMetrics = {
      ndcgAt10: ndcgAtK(baselineRelevances, idealRelevances, 10),
      recallAt20: recallAtK(baselineTitles, labelMap, 20),
      ilsAt10: await ilsAtK(baselinePaperIds, 10),
      subtopicCoverageAt10: subtopicCoverageAtK(baselineTitles, labelMap, 10),
    };
    const rerankedMetrics = {
      ndcgAt10: ndcgAtK(rerankedRelevances, idealRelevances, 10),
      recallAt20: recallAtK(rerankedTitles, labelMap, 20),
      ilsAt10: await ilsAtK(rerankedPaperIds, 10),
      subtopicCoverageAt10: subtopicCoverageAtK(rerankedTitles, labelMap, 10),
    };

    caseResults.push({
      id: caseEntry.id,
      caseClass: caseEntry.caseClass,
      seedPaperId: seedPaper.id,
      seedTitle: seedPaper.title,
      latencyMs: elapsedMs,
      budgetPass: elapsedMs <= budgets.related.cacheP95Ms,
      baseline: {
        top10: baselineTitles.slice(0, 10),
        metrics: baselineMetrics,
      },
      reranked: {
        backend: rerankResult.backend,
        top10: rerankedTitles.slice(0, 10),
        metrics: rerankedMetrics,
      },
      lift: {
        ndcgAt10: round(rerankedMetrics.ndcgAt10 - baselineMetrics.ndcgAt10),
        recallAt20: round(rerankedMetrics.recallAt20 - baselineMetrics.recallAt20),
        ilsAt10: round(rerankedMetrics.ilsAt10 - baselineMetrics.ilsAt10),
        subtopicCoverageAt10: round(
          rerankedMetrics.subtopicCoverageAt10 - baselineMetrics.subtopicCoverageAt10,
        ),
      },
    });
  }

  const summary = {
    task: "related-papers",
    split: "dev",
    backend: caseResults[0]?.reranked.backend ?? null,
    budgets: budgets.related,
    floors: floors.tasks.relatedPapers.dev,
    baseline: {
      ndcgAt10: average(caseResults.map((caseResult) => caseResult.baseline.metrics.ndcgAt10)),
      recallAt20: average(caseResults.map((caseResult) => caseResult.baseline.metrics.recallAt20)),
      ilsAt10: average(caseResults.map((caseResult) => caseResult.baseline.metrics.ilsAt10)),
      subtopicCoverageAt10: average(
        caseResults.map((caseResult) => caseResult.baseline.metrics.subtopicCoverageAt10),
      ),
    },
    reranked: {
      ndcgAt10: average(caseResults.map((caseResult) => caseResult.reranked.metrics.ndcgAt10)),
      recallAt20: average(caseResults.map((caseResult) => caseResult.reranked.metrics.recallAt20)),
      ilsAt10: average(caseResults.map((caseResult) => caseResult.reranked.metrics.ilsAt10)),
      subtopicCoverageAt10: average(
        caseResults.map((caseResult) => caseResult.reranked.metrics.subtopicCoverageAt10),
      ),
    },
    latencyP95Ms: caseResults
      .map((caseResult) => caseResult.latencyMs)
      .sort((left, right) => left - right)[Math.max(0, Math.ceil(caseResults.length * 0.95) - 1)],
    costP95UsdAmortized: 0,
  };

  const summaryWithFloors = {
    ...summary,
    floorChecks: Object.fromEntries(
      Object.entries(summary.reranked).map(([metric, value]) => [
        metric,
        compareToFloor(metric, value, summary.floors[metric as keyof typeof summary.floors] ?? null),
      ]),
    ),
  };

  const artifact = {
    ...summaryWithFloors,
    cases: caseResults,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
}

main().catch((error) => {
  console.error("[score-related-papers] Failed:", error);
  process.exit(1);
});
