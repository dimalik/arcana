import { describe, expect, it } from "vitest";

import type { RecommendationProfile } from "@/lib/recommendations/interests";

import {
  buildRecommendationSections,
  mergeRecommendationCandidates,
  rerankRecommendationCandidates,
} from "./recommendations-ranker";

function buildProfile(): RecommendationProfile {
  return {
    userId: "user-1",
    paperSeeds: [
      {
        paperId: "seed-1",
        title: "Efficient Language Modeling with Retrieval",
        weight: 1,
        doi: null,
        arxivId: null,
        citationCount: 100,
        tagNames: ["language models", "retrieval"],
        claimFacets: ["APPROACH", "RESOURCE"],
        externalSeedId: null,
      },
    ],
    arxivCategories: ["cs.CL"],
    contentQueries: [
      {
        query: "language models retrieval efficiency",
        sourcePaperTitle: "Efficient Language Modeling with Retrieval",
        weight: 1,
        source: "title",
      },
    ],
    tagWeights: [
      { value: "language models", weight: 1 },
      { value: "retrieval", weight: 0.8 },
    ],
    claimFacetWeights: [
      { value: "APPROACH", weight: 1 },
      { value: "RESOURCE", weight: 0.6 },
    ],
    newestYear: 2025,
    profileVector: [1, 0, 0, 0],
    seedVectors: [{ paperId: "seed-1", vector: [1, 0, 0, 0] }],
    relatedConsumptionPaperIds: [],
  };
}

describe("recommendations-ranker", () => {
  it("merges duplicate candidates across source kinds", () => {
    const merged = mergeRecommendationCandidates([
      {
        sourceKind: "s2",
        seedHint: null,
        paper: {
          title: "PagedAttention for LLM Serving",
          abstract: "Memory efficient serving for large language models.",
          authors: ["A", "B"],
          year: 2024,
          doi: "10.1000/paged",
          arxivId: null,
          externalUrl: "https://example.com/paged",
          citationCount: 120,
          openAccessPdfUrl: null,
          source: "s2",
          matchReason: "Based on your library profile",
        },
      },
      {
        sourceKind: "keyword",
        seedHint: "Efficient Language Modeling with Retrieval",
        paper: {
          title: "PagedAttention for LLM Serving",
          abstract: "Serving systems for language models.",
          authors: ["A", "B"],
          year: 2024,
          doi: "10.1000/paged",
          arxivId: null,
          externalUrl: "https://example.com/paged",
          citationCount: 140,
          openAccessPdfUrl: null,
          source: "openalex",
          matchReason: "Matched: Efficient Language Modeling with Retrieval",
        },
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].sourceKinds).toEqual(["s2", "keyword"]);
    expect(merged[0].seedHints).toEqual(["Efficient Language Modeling with Retrieval"]);
    expect(merged[0].citationCount).toBe(140);
    expect(merged[0].matchReasons).toHaveLength(2);
  });

  it("builds distinct recommended and latest sections", () => {
    const profile = buildProfile();
    const hits = Array.from({ length: 18 }, (_, index) => ({
      sourceKind:
        index % 3 === 0
          ? ("s2" as const)
          : index % 3 === 1
            ? ("arxiv" as const)
            : ("keyword" as const),
      seedHint:
        index % 3 === 2 ? "Efficient Language Modeling with Retrieval" : null,
      paper: {
        title: `Recommendation Candidate ${index + 1} for Retrieval Language Models`,
        abstract:
          index % 2 === 0
            ? "Retrieval augmented language models with efficient serving."
            : "Recent language-model systems paper for retrieval and efficiency.",
        authors: [String.fromCharCode(65 + (index % 5))],
        year: 2026 - (index % 4),
        doi: null,
        arxivId: `24${(index + 1).toString().padStart(2, "0")}.0000${index}`,
        externalUrl: `https://arxiv.org/abs/24${(index + 1)
          .toString()
          .padStart(2, "0")}.0000${index}`,
        citationCount: 25 - index,
        openAccessPdfUrl: null,
        source: index % 3 === 1 ? "arxiv" : "s2",
        matchReason:
          index % 3 === 1
            ? "cs.CL"
            : "Matched: Efficient Language Modeling with Retrieval",
      },
    }));

    const ranked = rerankRecommendationCandidates(
      profile,
      mergeRecommendationCandidates(hits),
    );

    const sections = buildRecommendationSections(profile, ranked);

    expect(sections.recommended.length).toBeGreaterThan(0);
    expect(sections.latest.length).toBeGreaterThan(0);

    const recommendedTitles = new Set(sections.recommended.map((paper) => paper.title));
    for (const paper of sections.latest) {
      expect(recommendedTitles.has(paper.title)).toBe(false);
    }
  });
});
