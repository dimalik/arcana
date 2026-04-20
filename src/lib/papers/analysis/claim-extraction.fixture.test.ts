import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../../llm/provider", () => ({
  generateStructuredObject: vi.fn(),
}));

import type { ExtractedPaperClaim } from "./extract-claims-schema";
import {
  dedupeStoredClaims,
  materializeStoredClaim,
} from "./claim-extraction";

interface ClaimCorpusCase {
  paperId: string;
  chunks: Array<{
    sectionLabel: string | null;
    claims: ExtractedPaperClaim[];
  }>;
}

describe("claim extraction fixture corpus", () => {
  it("matches the committed snapshot artifact", async () => {
    const repoRoot = process.cwd();
    const corpusPath = path.join(
      repoRoot,
      "benchmark/paper-analysis/claims.corpus.json",
    );
    const snapshotPath = path.join(
      repoRoot,
      "benchmark/paper-analysis/claims.snapshot.json",
    );

    const corpus = JSON.parse(
      await fs.readFile(corpusPath, "utf8"),
    ) as { cases: ClaimCorpusCase[] };
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));

    const actual = {
      cases: corpus.cases.map((testCase) => ({
        paperId: testCase.paperId,
        claims: dedupeStoredClaims(
          testCase.chunks.flatMap((chunk, chunkIndex) =>
            chunk.claims.map((claim, claimIndex) =>
              materializeStoredClaim(
                claim,
                chunk.sectionLabel,
                chunkIndex * 100 + claimIndex,
              ),
            ),
          ),
        ),
      })),
    };

    expect(actual).toEqual(snapshot);
  });
});
