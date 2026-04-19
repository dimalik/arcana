import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { collectPaperRelationReads } from "./lib/relation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function loadAllowlist() {
  const filePath = path.join(__dirname, "relation-readers.allowlist.json");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function flattenAllowlist(allowlist) {
  return new Set(Object.values(allowlist.readAllowlist).flat());
}

async function main() {
  const allowlist = await loadAllowlist();
  const allowedFiles = flattenAllowlist(allowlist);
  const reads = await collectPaperRelationReads(repoRoot);
  const unexpectedReads = reads.filter((read) => !allowedFiles.has(read.file));

  if (unexpectedReads.length > 0) {
    console.error("[check-relation-readers] Direct paperRelation reads detected outside allowlist.");
    for (const violation of unexpectedReads) {
      console.error(
        `  - ${violation.file}:${violation.line}:${violation.column} uses paperRelation.${violation.method}()`,
      );
    }
    process.exit(1);
  }

  console.log(
    `[check-relation-readers] OK (${reads.length} allowlisted reads across ${allowedFiles.size} files)`,
  );
}

main().catch((error) => {
  console.error("[check-relation-readers] Failed:", error);
  process.exit(1);
});
