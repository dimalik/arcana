import fs from "fs/promises";
import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";

import { collectRepoSourceFiles } from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function getScriptKind(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createSourceFile(sourceText, filePath) {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
}

function countNamedCalls(sourceText, filePath, names) {
  const sourceFile = createSourceFile(sourceText, filePath);
  let count = 0;

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return count;
}

async function loadInventory() {
  const inventoryPath = path.join(__dirname, "paper-llm-route-inventory.json");
  return JSON.parse(await fs.readFile(inventoryPath, "utf8"));
}

async function main() {
  const inventory = await loadInventory();
  const targetRoutes = inventory.targetRoutes;
  const excludedRoutes = inventory.excludedRoutes;
  const expectedFiles = new Set([
    ...Object.keys(targetRoutes),
    ...Object.keys(excludedRoutes),
  ]);

  const files = await collectRepoSourceFiles(repoRoot, ["src"]);
  const paperRouteFiles = files.filter((file) =>
    file.path.startsWith("src/app/api/papers/[id]/"),
  );

  const providerCallNames = new Set(["generateLLMResponse", "streamLLMResponse"]);
  const wrappedRoutes = [];
  const violations = [];

  for (const file of paperRouteFiles) {
    const providerCalls = countNamedCalls(file.text, file.path, providerCallNames);
    if (providerCalls === 0) continue;

    wrappedRoutes.push(file.path);

    if (!expectedFiles.has(file.path)) {
      violations.push(
        `${file.path} uses paper-scoped provider calls but is missing from paper-llm-route-inventory.json`,
      );
      continue;
    }

    if (file.path in excludedRoutes) {
      continue;
    }

    const wrappedCalls = countNamedCalls(
      file.text,
      file.path,
      new Set(["withPaperLlmContext"]),
    );
    const legacyCalls = countNamedCalls(
      file.text,
      file.path,
      new Set(["setLlmContext"]),
    );
    const expectedCalls = targetRoutes[file.path];

    if (providerCalls !== expectedCalls) {
      violations.push(
        `${file.path} expected ${expectedCalls} provider call(s) but found ${providerCalls}`,
      );
    }
    if (wrappedCalls !== expectedCalls) {
      violations.push(
        `${file.path} expected ${expectedCalls} withPaperLlmContext wrapper(s) but found ${wrappedCalls}`,
      );
    }
    if (legacyCalls > 0) {
      violations.push(
        `${file.path} still calls setLlmContext directly (${legacyCalls} occurrence(s))`,
      );
    }
  }

  for (const targetRoute of Object.keys(targetRoutes)) {
    if (!wrappedRoutes.includes(targetRoute)) {
      violations.push(`${targetRoute} is in the target inventory but no provider call was found`);
    }
  }

  if (violations.length > 0) {
    console.error("[check-paper-llm-contexts] Paper-scoped LLM context guardrail violations detected.");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-paper-llm-contexts] OK (${Object.keys(targetRoutes).length} stamped routes, ${Object.keys(excludedRoutes).length} explicit exclusions)`,
  );
}

main().catch((error) => {
  console.error("[check-paper-llm-contexts] Failed:", error);
  process.exit(1);
});
