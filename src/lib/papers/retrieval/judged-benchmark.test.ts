import { describe, expect, it } from "vitest";

import {
  benchmarkBudgetsSchema,
  benchmarkFloorsSchema,
  claimsJudgedSetSchema,
  devAgreementArtifactSchema,
} from "./judged-benchmark";

describe("judged benchmark schemas", () => {
  it("accepts draft claims judged scaffolding", () => {
    const parsed = claimsJudgedSetSchema.parse({
      task: "claims",
      split: "dev",
      status: "draft",
      cases: [
        {
          id: "claims-1",
          domain: "nlp",
          paper: { title: "Attention Is All You Need" },
          judgments: [],
        },
      ],
    });

    expect(parsed.cases).toHaveLength(1);
  });

  it("accepts draft agreement artifacts", () => {
    expect(
      devAgreementArtifactSchema.parse({
        task: "search",
        split: "dev",
        status: "draft",
        agreementMetric: "cohen_kappa",
        agreementValue: null,
        annotatorsPerCase: 2,
        adjudicatedCaseCount: 0,
      }),
    ).toBeTruthy();
  });

  it("accepts committed budget and draft floors shapes", () => {
    expect(
      benchmarkBudgetsSchema.parse({
        search: {
          apiP95Ms: 600,
          rerankerP95Ms: 400,
          candidateCap: 50,
          costP95Usd: 0.005,
          degradedPath: "feature_reranker",
        },
        related: {
          cacheP95Ms: 1500,
          candidateCap: 200,
          costP95UsdAmortized: 0.02,
          cacheTtlDays: 7,
          degradedPath: "deterministic_relatedness",
        },
        recommendations: {
          freshnessSlaHours: 24,
          readP95Ms: 200,
          costP95UsdPerUserDay: 0.1,
          degradedPath: "previous_cached_ranking",
        },
      }),
    ).toBeTruthy();

    expect(
      benchmarkFloorsSchema.parse({
        status: "draft",
        tasks: {
          claims: { dev: { claimF1: null }, holdout: { claimF1: null } },
          relatedPapers: { dev: { ndcgAt10: null }, holdout: { ndcgAt10: null } },
          search: { dev: { mrrAt10: null }, holdout: { mrrAt10: null } },
          recommendations: {
            dev: { noveltyAt10: null },
            holdout: { noveltyAt10: null },
          },
        },
      }),
    ).toBeTruthy();
  });
});
