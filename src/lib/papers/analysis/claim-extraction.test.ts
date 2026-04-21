import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("../../llm/provider", () => ({
  generateStructuredObject: vi.fn(),
}));

import {
  buildClaimExtractionChunks,
  dedupeStoredClaims,
  extractClaimsForPaper,
  materializeStoredClaim,
} from "./claim-extraction";

function createInMemoryAnalysisDb(seed?: {
  runs?: Array<Record<string, unknown>>;
  claims?: Array<Record<string, unknown>>;
}) {
  const runs = [...(seed?.runs ?? [])] as Array<any>;
  const claims = [...(seed?.claims ?? [])] as Array<any>;

  return {
    paperClaimRun: {
      findUnique: async ({
        where,
        include,
      }: {
        where: {
          paperId_extractorVersion_sourceTextHash: {
            paperId: string;
            extractorVersion: string;
            sourceTextHash: string;
          };
        };
        include?: { claims?: { orderBy?: { orderIndex: "asc" | "desc" } } };
      }) => {
        const run = runs.find(
          (candidate) =>
            candidate.paperId ===
              where.paperId_extractorVersion_sourceTextHash.paperId &&
            candidate.extractorVersion ===
              where.paperId_extractorVersion_sourceTextHash.extractorVersion &&
            candidate.sourceTextHash ===
              where.paperId_extractorVersion_sourceTextHash.sourceTextHash,
        );
        if (!run) return null;
        return include?.claims
          ? {
              ...run,
              claims: claims
                .filter((claim) => claim.runId === run.id)
                .sort((left, right) => left.orderIndex - right.orderIndex),
            }
          : run;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          paperId_extractorVersion_sourceTextHash: {
            paperId: string;
            extractorVersion: string;
            sourceTextHash: string;
          };
        };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existingIndex = runs.findIndex(
          (candidate) =>
            candidate.paperId ===
              where.paperId_extractorVersion_sourceTextHash.paperId &&
            candidate.extractorVersion ===
              where.paperId_extractorVersion_sourceTextHash.extractorVersion &&
            candidate.sourceTextHash ===
              where.paperId_extractorVersion_sourceTextHash.sourceTextHash,
        );
        if (existingIndex >= 0) {
          runs[existingIndex] = { ...runs[existingIndex], ...update };
          return runs[existingIndex];
        }
        const created = {
          id: `run-${runs.length + 1}`,
          createdAt: new Date("2026-04-20T00:00:00Z"),
          ...create,
        };
        runs.push(created);
        return created;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const index = runs.findIndex((run) => run.id === where.id);
        runs[index] = { ...runs[index], ...data };
        return runs[index];
      },
    },
    paperClaim: {
      deleteMany: async ({ where }: { where: { runId: string } }) => {
        let index = claims.length;
        while (index--) {
          if (claims[index].runId === where.runId) {
            claims.splice(index, 1);
          }
        }
      },
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        claims.push(...data);
      },
      findMany: async ({
        where,
      }: {
        where: { runId?: string; paperId?: string };
      }) => {
        let result = claims.slice();
        if (where.runId) {
          result = result.filter((claim) => claim.runId === where.runId);
        }
        if (where.paperId) {
          result = result.filter((claim) => claim.paperId === where.paperId);
        }
        return result.sort((left, right) => left.orderIndex - right.orderIndex);
      },
    },
    __runs: runs,
    __claims: claims,
  };
}

describe("claim extraction", () => {
  it("reuses the completed run for the same source hash", async () => {
    const text = "The model improves accuracy by 2 points.";
    const sourceTextHash = createHash("sha256").update(text).digest("hex");
    const db = createInMemoryAnalysisDb({
      runs: [
        {
          id: "run-1",
          paperId: "paper-1",
          extractorVersion: "paper-claims-v1",
          sourceTextHash,
          status: "COMPLETED",
          createdAt: new Date("2026-04-20T00:00:00Z"),
          completedAt: new Date("2026-04-20T00:01:00Z"),
        },
      ],
      claims: [
        {
          id: "claim-1",
          paperId: "paper-1",
          runId: "run-1",
          claimType: "evaluative",
          rhetoricalRole: "RESULT",
          facet: "RESULT",
          polarity: "ASSERTIVE",
          stance: null,
          evaluationContext: null,
          text: "The model improves accuracy by 2 points.",
          normalizedText: "the model improves accuracy by 2 points",
          confidence: 0.9,
          sectionLabel: "Results",
          sectionPath: "results",
          sourceExcerpt: "The model improves accuracy by 2 points.",
          excerptHash: "hash-1",
          sourceSpan: null,
          citationAnchors: null,
          evidenceType: "PRIMARY",
          orderIndex: 0,
          createdAt: new Date("2026-04-20T00:01:00Z"),
        },
      ],
    });

    const result = await extractClaimsForPaper({
      db: db as never,
      paperId: "paper-1",
      text,
      provider: "openai",
      modelId: "gpt-test",
      extractChunk: async () => {
        throw new Error("extractChunk should not run for cached result");
      },
    });

    expect(result.cached).toBe(true);
    expect(result.run.id).toBe("run-1");
    expect(result.claims).toHaveLength(1);
  });

  it("dedupes duplicate claims before persisting a run", async () => {
    const db = createInMemoryAnalysisDb();
    const text = [
      "Method",
      "",
      "We introduce CacheBack for cache-aware speculative decoding.",
      "",
      "Results",
      "",
      "CacheBack improves throughput by 18%.",
      "",
      "CacheBack improves throughput by 18%.",
    ].join("\n");

    const result = await extractClaimsForPaper({
      db: db as never,
      paperId: "paper-2",
      text,
      provider: "openai",
      modelId: "gpt-test",
      chunkLimit: 2,
      extractChunk: async ({ chunkIndex }) => ({
        claims:
          chunkIndex === 0
            ? [
                {
                  text: "CacheBack improves throughput by 18%.",
                  sourceExcerpt: "CacheBack improves throughput by 18%.",
                  rhetoricalRole: "result",
                  facet: "result",
                  polarity: "assertive",
                  evidenceType: "primary",
                  confidence: 0.9,
                },
              ]
            : [
                {
                  text: "CacheBack improves throughput by 18%.",
                  sourceExcerpt: "CacheBack improves throughput by 18%.",
                  rhetoricalRole: "result",
                  facet: "result",
                  polarity: "assertive",
                  evidenceType: "primary",
                  confidence: 0.88,
                },
              ],
      }),
    });

    expect(result.cached).toBe(false);
    expect(result.claims).toHaveLength(1);
    expect(db.__claims).toHaveLength(1);
  });

  it("builds section-aware chunks from body text", () => {
    const chunks = buildClaimExtractionChunks(
      [
        "Introduction",
        "",
        "This paragraph frames the problem.",
        "",
        "Method",
        "",
        "This paragraph explains the proposed method.",
      ].join("\n"),
      { chunkChars: 80, chunkLimit: 4 },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.sectionLabel).toBe("Introduction");
    expect(chunks[1]?.sectionLabel).toBe("Method");
  });

  it("materializes and dedupes claims deterministically", () => {
    const first = materializeStoredClaim(
      {
        text: "We propose a better optimizer.",
        sourceExcerpt: "We propose a better optimizer.",
        rhetoricalRole: "contribution",
        facet: "approach",
        polarity: "assertive",
        evidenceType: "primary",
        confidence: 0.9,
      },
      "Method",
      0,
    );
    const second = materializeStoredClaim(
      {
        text: "We propose a better optimizer.",
        sourceExcerpt: "We propose a better optimizer.",
        rhetoricalRole: "contribution",
        facet: "approach",
        polarity: "assertive",
        evidenceType: "primary",
        confidence: 0.7,
      },
      "Method",
      1,
    );

    const deduped = dedupeStoredClaims([first, second]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.orderIndex).toBe(0);
    expect(deduped[0]?.sectionPath).toBe("method");
  });

  it("normalizes relaxed transport fields before persistence", () => {
    const materialized = materializeStoredClaim(
      {
        text: "The model improves accuracy.",
        sourceExcerpt: "The model improves accuracy.",
        confidence: 1.7,
        sourceSpan: {
          charStart: -4,
          charEnd: 20,
          page: 0,
        },
      },
      "Results",
      0,
    );

    expect(materialized.confidence).toBe(1);
    expect(materialized.sourceSpan).toBeNull();
  });
});
