import fs from "fs";
import path from "path";

import * as rawBenchmarkModule from "../../src/lib/papers/retrieval/judged-benchmark.ts";

const benchmarkModule = rawBenchmarkModule.default ?? rawBenchmarkModule;

const {
  agreementArtifactSchema,
  benchmarkBudgetsSchema,
  benchmarkFloorsSchema,
  judgedSetSchemas,
} = benchmarkModule;

function valueFor(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function loadHoldoutJson(relativeName) {
  const fixturePath = process.env.HOLDOUT_FIXTURE_PATH;
  const fixtureUrl = process.env.HOLDOUT_FIXTURE_URL;

  if (fixturePath) {
    return readJson(path.join(fixturePath, relativeName));
  }

  if (fixtureUrl) {
    const token = process.env.HOLDOUT_FIXTURE_TOKEN;
    const response = await fetch(new URL(relativeName, fixtureUrl), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch holdout fixture ${relativeName}: ${response.status}`);
    }
    return response.json();
  }

  throw new Error(
    "Holdout fixture location is not configured. Set HOLDOUT_FIXTURE_PATH or HOLDOUT_FIXTURE_URL.",
  );
}

async function loadJudgedSet(repoRoot, task, split) {
  if (split === "dev") {
    return readJson(path.join(repoRoot, "benchmark", "judged", `${task}.dev.judged.json`));
  }
  return loadHoldoutJson(`${task}.holdout.judged.json`);
}

async function loadAgreementArtifact(repoRoot, task, split) {
  if (split === "dev") {
    return readJson(path.join(repoRoot, "benchmark", "judged", `${task}.dev.agreement.json`));
  }
  return loadHoldoutJson(`${task}.holdout.agreement.json`);
}

async function main() {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  const split = valueFor(argv, "--split") ?? "dev";
  const taskArg = valueFor(argv, "--task") ?? "all";
  const outPath = valueFor(argv, "--out");
  const tasks =
    taskArg === "all"
      ? Object.keys(judgedSetSchemas)
      : [taskArg];

  const budgets = benchmarkBudgetsSchema.parse(
    readJson(path.join(repoRoot, "benchmark", "budgets.json")),
  );
  const floors = benchmarkFloorsSchema.parse(
    readJson(path.join(repoRoot, "benchmark", "floors.json")),
  );

  const summary = {
    split,
    tasks: {},
    budgets,
    floorsStatus: floors.status,
  };

  for (const task of tasks) {
    if (!(task in judgedSetSchemas)) {
      throw new Error(`Unknown task: ${task}`);
    }

    const judgedSet = judgedSetSchemas[task].parse(
      await loadJudgedSet(repoRoot, task, split),
    );
    const agreement = agreementArtifactSchema.parse(
      split === "dev"
        ? await loadAgreementArtifact(repoRoot, task, split)
        : {
            ...(await loadAgreementArtifact(repoRoot, task, split)),
            split,
          },
    );

    summary.tasks[task] = {
      status: judgedSet.status,
      caseCount: judgedSet.cases.length,
      labelCount: judgedSet.cases.reduce((sum, entry) => sum + entry.judgments.length, 0),
      agreementStatus: agreement.status,
      agreementValue: agreement.agreementValue,
    };
  }

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[run-judged] Failed:", error);
  process.exit(1);
});
