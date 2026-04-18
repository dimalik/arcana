import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import {
  collectStatusDataWrites,
  collectTrackedSchemaFields,
} from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function loadAllowlist() {
  const filePath = path.join(__dirname, "processing-status-writers.allowlist.json");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function flattenAllowlist(allowlist) {
  return new Set(Object.values(allowlist.dataWriteAllowlist).flat());
}

async function main() {
  const allowlist = await loadAllowlist();
  const allowedFiles = flattenAllowlist(allowlist);

  const writes = await collectStatusDataWrites(repoRoot);
  const unexpectedWrites = writes.filter((write) => !allowedFiles.has(write.file));
  const schemaViolations = await collectTrackedSchemaFields(repoRoot);

  if (unexpectedWrites.length > 0 || schemaViolations.length > 0) {
    console.error("[check-processing-status-writers] Processing status guardrail violations detected.");
    if (unexpectedWrites.length > 0) {
      console.error("  Unexpected data writes:");
      for (const violation of unexpectedWrites) {
        console.error(
          `    - ${violation.file}:${violation.line}:${violation.column} writes ${violation.field}`,
        );
      }
    }
    if (schemaViolations.length > 0) {
      console.error("  User-facing request schemas must not accept runtime status fields:");
      for (const violation of schemaViolations) {
        console.error(
          `    - ${violation.file}:${violation.line}:${violation.column} declares ${violation.field}`,
        );
      }
    }
    process.exit(1);
  }

  console.log(
    `[check-processing-status-writers] OK (${writes.length} allowlisted writes across ${allowedFiles.size} files)`,
  );
}

main().catch((error) => {
  console.error("[check-processing-status-writers] Failed:", error);
  process.exit(1);
});
