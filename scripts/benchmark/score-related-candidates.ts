import fs from "fs";
import path from "path";

import { prisma } from "@/lib/prisma";
import { generateRelatedPaperCandidates } from "@/lib/papers/retrieval/candidate-generation";
import { generatePersonalizedPageRankRelatedCandidates } from "@/lib/papers/retrieval/personalized-pagerank";
import {
  benchmarkBudgetsSchema,
  relatedJudgedSetSchema,
  type JudgedLabel,
} from "@/lib/papers/retrieval/judged-benchmark";

function valueFor(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function recallAtK(
  titles: string[],
  labelMap: Map<string, JudgedLabel>,
  limit: number,
): number {
  const relevantTitles = new Set(
    Array.from(labelMap.values())
      .filter((label) => label.relevance > 0)
      .map((label) => label.title),
  );
  if (relevantTitles.size === 0) return 0;
  const hits = titles
    .slice(0, limit)
    .filter((title) => relevantTitles.has(title)).length;
  return round(hits / relevantTitles.size);
}

function firstRelevantRank(
  titles: string[],
  labelMap: Map<string, JudgedLabel>,
): number | null {
  for (let index = 0; index < titles.length; index += 1) {
    if ((labelMap.get(titles[index])?.relevance ?? 0) > 0) {
      return index + 1;
    }
  }

  return null;
}

async function resolvePaper(locator: {
  title: string;
  doi?: string;
  arxivId?: string;
}) {
  const orClauses: Array<{ title: string } | { doi: string } | { arxivId: string }> =
    [{ title: locator.title }];
  if (locator.doi) orClauses.push({ doi: locator.doi });
  if (locator.arxivId) orClauses.push({ arxivId: locator.arxivId });

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
    path.join(process.cwd(), "benchmark", "scored", "related-candidates.dev.scored.json");

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

  const caseResults = [];

  for (const caseEntry of judgedSet.cases) {
    const seedPaper = await resolvePaper(caseEntry.seed);
    if (!seedPaper?.userId) {
      throw new Error(`Unable to resolve seed paper for case ${caseEntry.id}`);
    }

    const labelMap = new Map(caseEntry.judgments.map((label) => [label.title, label]));

    const [mergedCandidates, pprCandidates] = await Promise.all([
      generateRelatedPaperCandidates(
        {
          paperId: seedPaper.id,
          userId: seedPaper.userId,
          mergedLimit: budgets.related.candidateCap,
          contentLimit: budgets.related.candidateCap,
          graphLimit: budgets.related.candidateCap,
        },
        prisma,
      ),
      generatePersonalizedPageRankRelatedCandidates(
        {
          paperId: seedPaper.id,
          userId: seedPaper.userId,
          limit: budgets.related.candidateCap,
        },
        prisma,
      ),
    ]);

    const mergedTitles = mergedCandidates.mergedCandidates.map((candidate) => candidate.title);
    const pprTitles = pprCandidates.candidates.map((candidate) => candidate.title);

    caseResults.push({
      id: caseEntry.id,
      caseClass: caseEntry.caseClass,
      seedPaperId: seedPaper.id,
      seedTitle: seedPaper.title,
      merged_v1: {
        top20: mergedTitles.slice(0, 20),
        metrics: {
          recallAt20: recallAtK(mergedTitles, labelMap, 20),
          recallAt50: recallAtK(mergedTitles, labelMap, 50),
          firstRelevantRank: firstRelevantRank(mergedTitles, labelMap),
        },
      },
      ppr_v1: {
        top20: pprTitles.slice(0, 20),
        metrics: {
          recallAt20: recallAtK(pprTitles, labelMap, 20),
          recallAt50: recallAtK(pprTitles, labelMap, 50),
          firstRelevantRank: firstRelevantRank(pprTitles, labelMap),
        },
        diagnostics: pprCandidates.diagnostics,
      },
    });
  }

  const mergedRecallAt20 = average(
    caseResults.map((result) => result.merged_v1.metrics.recallAt20),
  );
  const mergedRecallAt50 = average(
    caseResults.map((result) => result.merged_v1.metrics.recallAt50),
  );
  const pprRecallAt20 = average(
    caseResults.map((result) => result.ppr_v1.metrics.recallAt20),
  );
  const pprRecallAt50 = average(
    caseResults.map((result) => result.ppr_v1.metrics.recallAt50),
  );

  const output = {
    task: "related-papers-candidates",
    split: "dev",
    candidateCap: budgets.related.candidateCap,
    aggregate: {
      merged_v1: {
        recallAt20: mergedRecallAt20,
        recallAt50: mergedRecallAt50,
      },
      ppr_v1: {
        recallAt20: pprRecallAt20,
        recallAt50: pprRecallAt50,
      },
      lift: {
        recallAt20: round(pprRecallAt20 - mergedRecallAt20),
        recallAt50: round(pprRecallAt50 - mergedRecallAt50),
      },
    },
    cases: caseResults,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error("[score-related-candidates] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
