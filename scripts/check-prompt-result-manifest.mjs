import path from "path";
import { fileURLToPath } from "url";

import fs from "fs/promises";

import {
  collectPromptResultManifestTypesFromText,
  collectPromptResultWriterTypes,
} from "./lib/runtime-foundation-guardrails.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

async function main() {
  const writeSites = await collectPromptResultWriterTypes(repoRoot);
  const writerTypes = uniqueSorted(writeSites.map((site) => site.promptType));
  const manifestPath = path.join(repoRoot, "src/lib/llm/prompt-result-schemas.ts");
  const manifestText = await fs.readFile(manifestPath, "utf8");
  const manifestTypes = uniqueSorted(
    collectPromptResultManifestTypesFromText(manifestText, manifestPath).map(
      (entry) => entry.promptType,
    ),
  );

  const missingFromManifest = writerTypes.filter((type) => !manifestTypes.includes(type));
  const staleManifestTypes = manifestTypes.filter((type) => !writerTypes.includes(type));

  if (missingFromManifest.length > 0 || staleManifestTypes.length > 0) {
    console.error("[check-prompt-result-manifest] PromptResult manifest drift detected.");
    if (missingFromManifest.length > 0) {
      console.error(`  Missing manifest entries: ${missingFromManifest.join(", ")}`);
    }
    if (staleManifestTypes.length > 0) {
      console.error(`  Manifest entries with no live writer: ${staleManifestTypes.join(", ")}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-prompt-result-manifest] OK (${manifestTypes.length} prompt types): ${manifestTypes.join(", ")}`,
  );
}

main().catch((error) => {
  console.error("[check-prompt-result-manifest] Failed:", error);
  process.exit(1);
});
