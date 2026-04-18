import path from "path";
import { fileURLToPath } from "url";

import { collectSetLlmContextCalls } from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PROCESSING_ROOTS = ["src/lib/processing", "src/lib/llm/auto-process.ts"];

async function main() {
  const calls = await collectSetLlmContextCalls(repoRoot, PROCESSING_ROOTS);
  if (calls.length > 0) {
    console.error("[check-processing-als-usage] Processing paths still call setLlmContext directly.");
    for (const call of calls) {
      console.error(`  - ${call.file}:${call.line}:${call.column}`);
    }
    process.exit(1);
  }

  console.log("[check-processing-als-usage] OK (no direct processing-path setLlmContext usage)");
}

main().catch((error) => {
  console.error("[check-processing-als-usage] Failed:", error);
  process.exit(1);
});
