import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { collectPaperRelationWrites } from "./lib/relation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function loadAllowlist() {
  const filePath = path.join(__dirname, "relation-writers.allowlist.json");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function flattenAllowlist(allowlist) {
  return new Set(Object.values(allowlist.writeAllowlist).flat());
}

async function main() {
  const allowlist = await loadAllowlist();
  const allowedFiles = flattenAllowlist(allowlist);
  const writes = await collectPaperRelationWrites(repoRoot);
  const unexpectedWrites = writes.filter((write) => !allowedFiles.has(write.file));

  if (unexpectedWrites.length > 0) {
    console.error("[check-relation-writers] Direct paperRelation writes detected outside allowlist.");
    for (const violation of unexpectedWrites) {
      console.error(
        `  - ${violation.file}:${violation.line}:${violation.column} uses paperRelation.${violation.method}()`,
      );
    }
    process.exit(1);
  }

  console.log(
    `[check-relation-writers] OK (${writes.length} allowlisted writes across ${allowedFiles.size} files)`,
  );
}

main().catch((error) => {
  console.error("[check-relation-writers] Failed:", error);
  process.exit(1);
});
