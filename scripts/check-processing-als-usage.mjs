import path from "path";
import { fileURLToPath } from "url";

import { collectSetLlmContextCalls } from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PROCESSING_ROOTS = ["src/lib/processing", "src/lib/llm/auto-process.ts"];
const TEMPORARY_ALLOWED_LEGACY_CALLS = new Set(["src/lib/processing/batch.ts"]);

async function main() {
  const calls = await collectSetLlmContextCalls(repoRoot, PROCESSING_ROOTS);
  const unexpectedCalls = calls.filter((call) => !TEMPORARY_ALLOWED_LEGACY_CALLS.has(call.file));

  if (unexpectedCalls.length > 0) {
    console.error("[check-processing-als-usage] Processing paths still call setLlmContext directly.");
    for (const call of unexpectedCalls) {
      console.error(`  - ${call.file}:${call.line}:${call.column}`);
    }
    process.exit(1);
  }

  if (calls.length > 0) {
    console.warn(
      `[check-processing-als-usage] Temporary legacy callsites remain: ${Array.from(TEMPORARY_ALLOWED_LEGACY_CALLS).join(", ")}. Remove in PR 2.`,
    );
  } else {
    console.log("[check-processing-als-usage] OK (no direct processing-path setLlmContext usage)");
  }
}

main().catch((error) => {
  console.error("[check-processing-als-usage] Failed:", error);
  process.exit(1);
});
