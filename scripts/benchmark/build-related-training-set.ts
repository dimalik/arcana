import fs from "fs";
import path from "path";

import { buildRelatedTrainingCorpus, buildRelatedBatchLabelPayload } from "@/lib/papers/retrieval/related-training";
import { relatedJudgedSetSchema } from "@/lib/papers/retrieval/judged-benchmark";

function valueFor(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function integerFor(
  argv: string[],
  flag: string,
  fallback: number,
): number {
  const value = valueFor(argv, flag);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const outDir =
    valueFor(argv, "--out-dir") ??
    path.join(process.cwd(), "benchmark", "training", "related-papers");
  const backendId =
    valueFor(argv, "--backend") ??
    process.env.ARCANA_RELATED_RERANKER_BACKEND ??
    "feature_v1";
  const judgedPath =
    valueFor(argv, "--judged") ??
    path.join(process.cwd(), "benchmark", "judged", "related-papers.dev.judged.json");

  const judgedSet = relatedJudgedSetSchema.parse(
    JSON.parse(fs.readFileSync(judgedPath, "utf8")),
  );

  const corpus = await buildRelatedTrainingCorpus({
    judgedSet,
    backendId: backendId as never,
    trainSeedLimit: integerFor(argv, "--train-limit", 400),
    maxWeakPositivesPerSeed: integerFor(argv, "--max-positives-per-seed", 6),
    maxHardNegativesPerSeed: integerFor(argv, "--max-negatives-per-seed", 8),
  });

  ensureDirectory(outDir);

  const summaryPath = path.join(outDir, "related.summary.json");
  const devPairsPath = path.join(outDir, "related.dev.pairs.jsonl");
  const trainPairsPath = path.join(outDir, "related.train.pairs.jsonl");
  const devCasesPath = path.join(outDir, "related.dev.cases.json");
  const trainCasesPath = path.join(outDir, "related.train.cases.json");
  const batchPayloadsPath = path.join(outDir, "related.batch-labeling.jsonl");

  writeJson(summaryPath, {
    task: corpus.task,
    version: corpus.version,
    generatedAt: corpus.generatedAt,
    backendId: corpus.backendId,
    judgedSplit: corpus.judgedSplit,
    summary: corpus.summary,
  });
  writeJsonl(devPairsPath, corpus.devPairs);
  writeJsonl(trainPairsPath, corpus.trainPairs);
  writeJson(devCasesPath, corpus.devCases);
  writeJson(trainCasesPath, corpus.trainCases);
  writeJsonl(
    batchPayloadsPath,
    corpus.trainPairs
      .filter((pair) => pair.label.source !== "judged")
      .map((pair) => ({
        customId: pair.id,
        task: "related-papers-llm-labeling",
        split: pair.split,
        payload: buildRelatedBatchLabelPayload(pair),
      })),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        outDir,
        trainPairCount: corpus.summary.trainPairCount,
        devPairCount: corpus.summary.devPairCount,
        bySource: corpus.summary.bySource,
        byFacet: corpus.summary.byFacet,
        weakSeedCount: corpus.summary.weakSeedCount,
        judgedUnresolvedCount: corpus.summary.judgedUnresolvedCount,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
