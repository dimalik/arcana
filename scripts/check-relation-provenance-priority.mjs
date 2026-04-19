import path from "path";
import { fileURLToPath } from "url";

import { collectProvenancePriorityLiterals } from "./lib/relation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SHARED_PROVENANCE_FILE = "src/lib/assertions/provenance.ts";

async function main() {
  const literals = await collectProvenancePriorityLiterals(repoRoot);
  const unexpectedLiterals = literals.filter((literal) => literal.file !== SHARED_PROVENANCE_FILE);

  if (unexpectedLiterals.length > 0) {
    console.error("[check-relation-provenance-priority] Duplicate provenance priority literals detected.");
    for (const violation of unexpectedLiterals) {
      console.error(`  - ${violation.file}:${violation.line}:${violation.column}`);
    }
    process.exit(1);
  }

  console.log("[check-relation-provenance-priority] OK (shared provenance module is the only priority ladder)");
}

main().catch((error) => {
  console.error("[check-relation-provenance-priority] Failed:", error);
  process.exit(1);
});
