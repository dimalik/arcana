import path from "path";
import { fileURLToPath } from "url";

import { collectRepoSourceFiles } from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const ROUTE_DIR = "src/app/api/papers/[id]/";
const ROUTE_FILE_PATTERN = /\/route\.ts$/;

const READ_OVERRIDE_ROUTES = new Set([
  "src/app/api/papers/[id]/references/[refId]/lookup/route.ts",
]);

const HEADER_REQUIRED_MUTATION_ROUTES = new Set([
  "src/app/api/papers/[id]/agent/route.ts",
  "src/app/api/papers/[id]/conversations/[convId]/messages/route.ts",
  "src/app/api/papers/[id]/llm/chat/route.ts",
  "src/app/api/papers/[id]/references/enrich/route.ts",
]);

const DETAIL_BODY_STATE_ROUTES = new Set([
  "src/app/api/papers/[id]/route.ts",
]);

const DUPLICATE_STATE_ROUTE = "src/app/api/papers/[id]/duplicate-state/route.ts";

function hasExportedHandler(sourceText, method) {
  return new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(sourceText);
}

function hasHeaderHelper(sourceText) {
  return /\bjsonWithDuplicateState\b/.test(sourceText) || /setDuplicateStateHeaders\s*\(/.test(sourceText);
}

async function main() {
  const files = await collectRepoSourceFiles(repoRoot, ["src"]);
  const routeFiles = files
    .filter((file) => file.path.startsWith(ROUTE_DIR) && ROUTE_FILE_PATTERN.test(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));

  const violations = [];

  for (const file of routeFiles) {
    const sourceText = file.text;
    const hasGet = hasExportedHandler(sourceText, "GET");
    const hasPost = hasExportedHandler(sourceText, "POST");
    const hasPatch = hasExportedHandler(sourceText, "PATCH");
    const hasDelete = hasExportedHandler(sourceText, "DELETE");
    const hasReadContract = hasGet || READ_OVERRIDE_ROUTES.has(file.path);
    const hasMutatingHandler =
      (hasPost && !READ_OVERRIDE_ROUTES.has(file.path)) || hasPatch || hasDelete;

    if (!/\brequirePaperAccess\b/.test(sourceText)) {
      violations.push(`${file.path} does not call requirePaperAccess(...)`);
    }

    if (file.path === DUPLICATE_STATE_ROUTE) {
      if (!/mode:\s*"duplicate_state"/.test(sourceText)) {
        violations.push(`${file.path} must use requirePaperAccess(..., { mode: "duplicate_state" })`);
      }
    } else if (hasMutatingHandler && !/mode:\s*"mutate"/.test(sourceText)) {
      violations.push(`${file.path} has mutating handlers but does not use mode: "mutate"`);
    }

    if (hasReadContract && !hasHeaderHelper(sourceText)) {
      violations.push(`${file.path} has a read surface but does not emit duplicate-state headers`);
    }

    if (HEADER_REQUIRED_MUTATION_ROUTES.has(file.path) && !/setDuplicateStateHeaders\s*\(/.test(sourceText)) {
      violations.push(`${file.path} streams or returns binary/mutation responses and must call setDuplicateStateHeaders(...)`);
    }

    if (DETAIL_BODY_STATE_ROUTES.has(file.path)) {
      if (!/includeBodyState:\s*true/.test(sourceText)) {
        violations.push(`${file.path} must include duplicateState/collapsedIntoPaperId in the JSON body`);
      }
    } else if (/includeBodyState:\s*true/.test(sourceText)) {
      violations.push(`${file.path} unexpectedly adds duplicate state into the response body`);
    }
  }

  if (violations.length > 0) {
    console.error("[check-paper-api-duplicate-state] Paper API duplicate-state guardrail violations detected.");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-paper-api-duplicate-state] OK (${routeFiles.length} paper-scoped route files audited, ${HEADER_REQUIRED_MUTATION_ROUTES.size} streaming/binary mutation routes checked)`,
  );
}

main().catch((error) => {
  console.error("[check-paper-api-duplicate-state] Failed:", error);
  process.exit(1);
});
