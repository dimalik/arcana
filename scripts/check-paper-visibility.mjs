import path from "path";
import { fileURLToPath } from "url";

import { collectRepoSourceFiles } from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const QUERY_PATTERN = /prisma\.paper\.(findMany|findFirst|findUnique|count)\s*\(/g;
const VISIBILITY_HELPER_PATTERN = /\b(mergePaperVisibilityWhere|paperVisibilityWhere|isUserVisiblePaper)\b/;

const REQUIRED_HELPER_FILES = new Set([
  "src/app/api/tags/clusters/route.ts",
  "src/app/api/papers/route.ts",
  "src/app/api/synthesis/route.ts",
  "src/lib/recommendations/engine.ts",
  "src/lib/recommendations/interests.ts",
]);

const ALLOWED_PREFIXES = [
  "src/app/api/admin/",
  "src/app/api/papers/[id]/",
  "src/app/api/papers/import/",
  "src/app/api/papers/maintenance/",
  "src/app/api/research/",
  "src/lib/canonical/",
  "src/lib/citations/",
  "src/lib/discovery/",
  "src/lib/engagement/",
  "src/lib/figures/",
  "src/lib/llm/",
  "src/lib/papers/",
  "src/lib/processing/",
  "src/lib/references/",
  "src/lib/research/",
  "src/lib/tags/",
];

const ALLOWED_FILES = new Set([
  "src/app/api/discovery/route.ts",
  "src/app/api/engagement/route.ts",
  "src/app/api/notebook/route.ts",
  "src/app/api/onboarding/import-seeds/route.ts",
  "src/app/api/papers/lookup/route.ts",
  "src/app/api/search/import/route.ts",
  "src/app/api/stats/route.ts",
  "src/app/api/upload/route.ts",
  "src/lib/paper-auth.ts",
]);

function isAllowedPath(filePath) {
  return ALLOWED_FILES.has(filePath) || ALLOWED_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

async function main() {
  const files = await collectRepoSourceFiles(repoRoot, ["src"]);
  const violations = [];
  const matchedFiles = [];

  for (const file of files) {
    const matches = file.text.match(QUERY_PATTERN);
    if (!matches?.length) continue;
    matchedFiles.push(file.path);

    if (REQUIRED_HELPER_FILES.has(file.path)) {
      if (!VISIBILITY_HELPER_PATTERN.test(file.text)) {
        violations.push(
          `${file.path} queries prisma.paper directly but does not use the shared paper visibility helper`,
        );
      }
      continue;
    }

    if (!isAllowedPath(file.path)) {
      violations.push(
        `${file.path} queries prisma.paper directly but is not in the duplicate-visibility allow-list`,
      );
    }
  }

  for (const requiredFile of REQUIRED_HELPER_FILES) {
    if (!matchedFiles.includes(requiredFile)) {
      violations.push(
        `${requiredFile} is expected to remain a duplicate-filtered paper reader but no prisma.paper query was found`,
      );
      continue;
    }

    const file = files.find((entry) => entry.path === requiredFile);
    if (file && !VISIBILITY_HELPER_PATTERN.test(file.text)) {
      violations.push(
        `${requiredFile} no longer references the shared paper visibility helper`,
      );
    }
  }

  if (violations.length > 0) {
    console.error("[check-paper-visibility] Duplicate visibility guardrail violations detected.");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-paper-visibility] OK (${matchedFiles.length} direct prisma.paper reader files audited, ${REQUIRED_HELPER_FILES.size} helper-enforced surfaces)`,
  );
}

main().catch((error) => {
  console.error("[check-paper-visibility] Failed:", error);
  process.exit(1);
});
