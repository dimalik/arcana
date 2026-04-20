import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { collectRepoSourceFiles } from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const INVENTORY_PATH = path.join(__dirname, "paper-analysis-route-inventory.json");
const ANALYSIS_ROUTE_SEGMENTS = [
  "gap-finder",
  "timeline",
  "compare-methodologies",
  "claims",
  "contradictions",
];

function isAnalysisRoute(filePath) {
  return (
    filePath.startsWith("src/app/api/papers/[id]/llm/") &&
    filePath.endsWith("/route.ts") &&
    ANALYSIS_ROUTE_SEGMENTS.some((segment) => filePath.includes(`/${segment}/`))
  );
}

function countNamedCalls(sourceText, name) {
  return (sourceText.match(new RegExp(`\\b${name}\\s*\\(`, "g")) ?? []).length;
}

async function loadInventory() {
  return JSON.parse(await fs.readFile(INVENTORY_PATH, "utf8"));
}

async function main() {
  const inventory = await loadInventory();
  const targetRoutes = inventory.targetRoutes ?? {};
  const excludedRoutes = inventory.excludedRoutes ?? {};
  const expectedRoutes = new Set([
    ...Object.keys(targetRoutes),
    ...Object.keys(excludedRoutes),
  ]);

  const files = await collectRepoSourceFiles(repoRoot, ["src"]);
  const analysisRoutes = files.filter((file) => isAnalysisRoute(file.path));
  const violations = [];

  for (const route of analysisRoutes) {
    if (!expectedRoutes.has(route.path)) {
      violations.push(
        `${route.path} looks like a paper-analysis route but is missing from paper-analysis-route-inventory.json`,
      );
      continue;
    }

    if (route.path in excludedRoutes) continue;

    const expectedCalls = targetRoutes[route.path];
    const actualCalls = countNamedCalls(route.text, "runPaperAnalysisCapability");
    if (actualCalls !== expectedCalls) {
      violations.push(
        `${route.path} expected ${expectedCalls} runPaperAnalysisCapability call(s) but found ${actualCalls}`,
      );
    }
  }

  for (const targetRoute of Object.keys(targetRoutes)) {
    if (!analysisRoutes.some((route) => route.path === targetRoute)) {
      violations.push(
        `${targetRoute} is in the target inventory but no matching analysis route file was found`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      "[check-paper-analysis-routes] Paper-analysis route inventory violations detected.",
    );
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-paper-analysis-routes] OK (${analysisRoutes.length} inventoried route(s), ${Object.keys(excludedRoutes).length} explicit exclusions)`,
  );
}

main().catch((error) => {
  console.error("[check-paper-analysis-routes] Failed:", error);
  process.exit(1);
});
