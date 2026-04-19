import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const mod = await import("../src/lib/usage-segmentation.ts");
  const {
    getKnownPaperUsageOperations,
    getProviderUsageSegment,
    PAPER_COST_SEGMENTS,
  } = mod;

  const knownPaperOperations = getKnownPaperUsageOperations();
  const unclassified = knownPaperOperations.filter(
    (operation) => getProviderUsageSegment(operation) === "unclassified",
  );

  const processingChecks = [
    ["processing_summarize", "processing"],
    ["processing_extract", "processing"],
    ["processing_extractReferences", "reference_enrichment"],
    ["processing_extractCitationContexts", "reference_enrichment"],
  ];

  const processingViolations = processingChecks.filter(
    ([operation, expected]) => getProviderUsageSegment(operation) !== expected,
  );

  const unknownSegment = getProviderUsageSegment("totally_unknown_operation");
  if (
    !PAPER_COST_SEGMENTS.includes("unclassified") ||
    unclassified.length > 0 ||
    processingViolations.length > 0 ||
    unknownSegment !== "unclassified"
  ) {
    console.error("[check-paper-usage-segments] Paper cost segmentation guardrail violations detected.");
    if (unclassified.length > 0) {
      console.error("  Unclassified known paper operations:");
      for (const operation of unclassified) {
        console.error(`    - ${operation}`);
      }
    }
    if (processingViolations.length > 0) {
      console.error("  Processing/reference segmentation mismatches:");
      for (const [operation, expected] of processingViolations) {
        console.error(
          `    - ${operation} resolved to ${getProviderUsageSegment(operation)} (expected ${expected})`,
        );
      }
    }
    if (unknownSegment !== "unclassified") {
      console.error(
        `  Unknown operations must remain unclassified (got ${unknownSegment})`,
      );
    }
    process.exit(1);
  }

  console.log(
    `[check-paper-usage-segments] OK (${knownPaperOperations.length} known paper operation(s) mapped, unknown -> unclassified)`,
  );
}

main().catch((error) => {
  console.error("[check-paper-usage-segments] Failed:", error);
  process.exit(1);
});
