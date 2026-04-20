import fs from "node:fs/promises";
import path from "node:path";

import type { ExtractedPaperClaim } from "@/lib/papers/analysis";
import {
  dedupeStoredClaims,
  materializeStoredClaim,
} from "@/lib/papers/analysis";

interface ClaimCorpusCase {
  paperId: string;
  chunks: Array<{
    sectionLabel: string | null;
    claims: ExtractedPaperClaim[];
  }>;
}

interface ClaimCorpus {
  cases: ClaimCorpusCase[];
}

async function main() {
  const repoRoot = process.cwd();
  const corpusPath = path.join(repoRoot, "benchmark/paper-analysis/claims.corpus.json");
  const outputPath = path.join(repoRoot, "benchmark/paper-analysis/claims.snapshot.json");
  const corpus = JSON.parse(
    await fs.readFile(corpusPath, "utf8"),
  ) as ClaimCorpus;

  const snapshot = {
    cases: corpus.cases.map((testCase) => {
      const claims = dedupeStoredClaims(
        testCase.chunks.flatMap((chunk, chunkIndex) =>
          chunk.claims.map((claim, claimIndex) =>
            materializeStoredClaim(
              claim,
              chunk.sectionLabel,
              chunkIndex * 100 + claimIndex,
            ),
          ),
        ),
      );

      return {
        paperId: testCase.paperId,
        claims,
      };
    }),
  };

  await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `[benchmark-paper-claims] Wrote ${snapshot.cases.length} fixture case(s) to ${path.relative(repoRoot, outputPath)}`,
  );
}

main().catch((error) => {
  console.error("[benchmark-paper-claims] Failed:", error);
  process.exit(1);
});
