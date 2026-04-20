import { describe, expect, it } from "vitest";

import {
  buildRelatedBatchLabelPayload,
  isHardNegativeCandidate,
  mapRelationTypeToFacets,
  parseRelatedTrainingCorpus,
} from "./related-training";

describe("related-training helpers", () => {
  it("maps assertion relation types into retrieval facets", () => {
    expect(mapRelationTypeToFacets("addresses same problem")).toEqual(["topic"]);
    expect(mapRelationTypeToFacets("related methodology")).toEqual([
      "methodology",
    ]);
    expect(mapRelationTypeToFacets("builds upon")).toEqual(["lineage"]);
    expect(mapRelationTypeToFacets("cites")).toEqual(["citation"]);
  });

  it("marks only meaningfully confusable candidates as hard negatives", () => {
    expect(
      isHardNegativeCandidate({
        paperId: "candidate",
        title: "Candidate",
        baselineConfidence: 0.1,
        rerankScore: 0.22,
        semanticSimilarity: 0.28,
        titleSimilarity: 0.02,
        queryTitleOverlap: 0.1,
        queryTitleOverlapCount: 1,
        bodyTokenOverlap: 0.08,
        tagOverlap: 0,
        lexicalAuthorOverlap: 0,
        identityAuthorOverlap: 0,
        venueOverlap: 0,
        yearProximity: 0.5,
        hubScore: 0.2,
        citationPrior: 0.1,
        relationTypePrior: 0,
        deterministicSignals: {
          direct_citation: 0,
          reverse_citation: 0,
          bibliographic_coupling: 0,
          co_citation: 0,
          title_similarity: 0,
        },
        subtopics: [],
      }),
    ).toBe(true);

    expect(
      isHardNegativeCandidate({
        paperId: "trivial",
        title: "Trivial",
        baselineConfidence: 0.01,
        rerankScore: 0.04,
        semanticSimilarity: 0.01,
        titleSimilarity: 0.01,
        queryTitleOverlap: 0,
        queryTitleOverlapCount: 0,
        bodyTokenOverlap: 0,
        tagOverlap: 0,
        lexicalAuthorOverlap: 0,
        identityAuthorOverlap: 0,
        venueOverlap: 0,
        yearProximity: 0,
        hubScore: 0,
        citationPrior: 0,
        relationTypePrior: 0,
        deterministicSignals: {
          direct_citation: 0,
          reverse_citation: 0,
          bibliographic_coupling: 0,
          co_citation: 0,
          title_similarity: 0,
        },
        subtopics: [],
      }),
    ).toBe(false);
  });

  it("parses a minimal related training corpus and batch labeling payload", () => {
    const corpus = parseRelatedTrainingCorpus({
      task: "related-papers-training",
      version: "related_training_v1",
      generatedAt: "2026-04-20T00:00:00.000Z",
      backendId: "feature_v1",
      judgedSplit: "dev",
      trainPairs: [],
      devPairs: [
        {
          id: "pair-1",
          pairKey: "seed::candidate",
          split: "dev",
          seedCaseId: "case-1",
          seedPaper: {
            id: "seed",
            entityId: null,
            title: "Seed",
            abstract: null,
            summary: null,
            authors: [],
            year: 2024,
            venue: null,
            doi: null,
            arxivId: null,
            citationCount: 10,
          },
          candidatePaper: {
            id: "candidate",
            entityId: null,
            title: "Candidate",
            abstract: null,
            summary: null,
            authors: [],
            year: 2024,
            venue: null,
            doi: null,
            arxivId: null,
            citationCount: 5,
          },
          label: {
            relevance: 2,
            facets: ["topic"],
            subtopics: ["llm-inference"],
            source: "judged",
            strength: "gold",
            relationTypes: [],
            rationale: null,
          },
          features: {
            baselineConfidence: 0.4,
            rerankScore: 0.5,
            semanticSimilarity: 0.2,
            titleSimilarity: 0.2,
            queryTitleOverlap: 0.3,
            queryTitleOverlapCount: 2,
            bodyTokenOverlap: 0.1,
            tagOverlap: 0.1,
            lexicalAuthorOverlap: 0,
            identityAuthorOverlap: 0,
            venueOverlap: 0,
            yearProximity: 1,
            hubScore: 0.1,
            citationPrior: 0.2,
            relationTypePrior: 0.1,
            deterministicSignals: {
              directCitation: 0,
              reverseCitation: 0,
              bibliographicCoupling: 0.1,
              coCitation: 0,
              titleSimilarity: 0.2,
            },
            baselineRank: 1,
            rerankedRank: 1,
            inBaseline: true,
            inReranked: true,
          },
          provenance: {
            backendId: "feature_v1",
            judgedCaseClass: "hub",
            candidateRankSource: "reranked",
          },
        },
      ],
      trainCases: [],
      devCases: [],
      summary: {
        totalPairs: 1,
        trainPairCount: 0,
        devPairCount: 1,
        bySource: {
          judged: 1,
        },
        byFacet: {
          topic: 1,
        },
        judgedUnresolvedCount: 0,
        weakSeedCount: 0,
      },
    });

    expect(corpus.devPairs).toHaveLength(1);
    expect(buildRelatedBatchLabelPayload(corpus.devPairs[0]).seedPaper.id).toBe(
      "seed",
    );
  });
});
