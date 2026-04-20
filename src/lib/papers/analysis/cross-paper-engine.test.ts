import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/assertions/relation-reader", () => ({
  listProjectedTargetPaperIds: vi.fn(),
}));

vi.mock("@/lib/llm/provider", () => ({
  generateStructuredObject: vi.fn(),
}));

vi.mock("@/lib/llm/prompts", () => ({
  SYSTEM_PROMPTS: {
    findGaps: "find-gaps",
    buildTimeline: "build-timeline",
    compareMethodologies: "compare-methodologies",
  },
}));

vi.mock("@/lib/llm/runtime-output-schemas", () => ({
  detectContradictionsRuntimeOutputSchema: {
    parse: (value: unknown) => value,
  },
  findGapsRuntimeOutputSchema: {},
  buildTimelineRuntimeOutputSchema: {},
  compareMethodologiesRuntimeOutputSchema: {},
}));

vi.mock("@/lib/llm/paper-llm-context", () => ({
  PAPER_ANALYSIS_LLM_OPERATIONS: {
    EXTRACT_CLAIMS: "paper_extract_claims",
    DETECT_CONTRADICTIONS: "paper_detect_contradictions",
    FIND_GAPS: "paper_gap_finder",
    BUILD_TIMELINE: "paper_timeline",
    COMPARE_METHODOLOGIES: "paper_compare_methodologies",
  },
  withPaperLlmContext: vi.fn((_context, callback) => callback()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import { buildContradictionCandidates } from "./cross-paper-engine";

describe("cross-paper contradiction candidates", () => {
  it("only emits candidates for aligned stance triples and matching evaluation context", () => {
    const candidates = buildContradictionCandidates({
      seedPaper: {
        id: "seed",
        title: "Seed",
        year: 2024,
        abstract: null,
        summary: null,
        keyFindings: null,
        fullText: null,
        claims: [
          {
            id: "claim-1",
            paperId: "seed",
            runId: "run-1",
            claimType: "evaluative",
            rhetoricalRole: "RESULT",
            facet: "RESULT",
            polarity: "ASSERTIVE",
            stance: {
              subjectText: "Method X",
              predicateText: "improves",
              objectText: "accuracy",
            },
            evaluationContext: {
              task: "classification",
              dataset: "MNLI",
              metric: "accuracy",
            },
            text: "Method X improves accuracy on MNLI.",
            normalizedText: "method x improves accuracy on mnli",
            confidence: 0.9,
            sectionLabel: "Results",
            sectionPath: "results",
            sourceExcerpt: "Method X improves accuracy on MNLI.",
            excerptHash: "hash-1",
            sourceSpan: null,
            citationAnchors: [],
            evidenceType: "PRIMARY",
            orderIndex: 0,
            createdAt: new Date("2026-04-20T00:00:00Z"),
          },
        ],
      },
      relatedPapers: [
        {
          id: "paper-a",
          title: "Paper A",
          year: 2023,
          abstract: null,
          summary: null,
          keyFindings: null,
          fullText: null,
          claims: [
            {
              id: "claim-a",
              paperId: "paper-a",
              runId: "run-a",
              claimType: "evaluative",
              rhetoricalRole: "RESULT",
              facet: "RESULT",
              polarity: "NEGATED",
              stance: {
                subjectText: "Method X",
                predicateText: "improves",
                objectText: "accuracy",
              },
              evaluationContext: {
                task: "classification",
                dataset: "MNLI",
                metric: "accuracy",
              },
              text: "Method X does not improve accuracy on MNLI.",
              normalizedText: "method x does not improve accuracy on mnli",
              confidence: 0.88,
              sectionLabel: "Results",
              sectionPath: "results",
              sourceExcerpt: "Method X does not improve accuracy on MNLI.",
              excerptHash: "hash-a",
              sourceSpan: null,
              citationAnchors: [],
              evidenceType: "PRIMARY",
              orderIndex: 0,
              createdAt: new Date("2026-04-20T00:00:00Z"),
            },
            {
              id: "claim-b",
              paperId: "paper-a",
              runId: "run-a",
              claimType: "evaluative",
              rhetoricalRole: "RESULT",
              facet: "RESULT",
              polarity: "NEGATED",
              stance: {
                subjectText: "Method X",
                predicateText: "improves",
                objectText: "accuracy",
              },
              evaluationContext: {
                task: "classification",
                dataset: "SST-2",
                metric: "accuracy",
              },
              text: "Method X does not improve accuracy on SST-2.",
              normalizedText: "method x does not improve accuracy on sst 2",
              confidence: 0.88,
              sectionLabel: "Results",
              sectionPath: "results",
              sourceExcerpt: "Method X does not improve accuracy on SST-2.",
              excerptHash: "hash-b",
              sourceSpan: null,
              citationAnchors: [],
              evidenceType: "PRIMARY",
              orderIndex: 1,
              createdAt: new Date("2026-04-20T00:00:00Z"),
            },
            {
              id: "claim-c",
              paperId: "paper-a",
              runId: "run-a",
              claimType: "contextual",
              rhetoricalRole: "BACKGROUND",
              facet: "RESULT",
              polarity: "NEGATED",
              stance: {
                subjectText: "Method X",
                predicateText: "improves",
                objectText: "accuracy",
              },
              evaluationContext: {
                task: "classification",
                dataset: "MNLI",
                metric: "accuracy",
              },
              text: "Prior work reported no improvement.",
              normalizedText: "prior work reported no improvement",
              confidence: 0.7,
              sectionLabel: "Related Work",
              sectionPath: "related_work",
              sourceExcerpt: "Prior work reported no improvement.",
              excerptHash: "hash-c",
              sourceSpan: null,
              citationAnchors: [],
              evidenceType: "CITING",
              orderIndex: 2,
              createdAt: new Date("2026-04-20T00:00:00Z"),
            },
          ],
        },
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        conflictingPaperId: "paper-a",
        severity: "direct",
      }),
    );
  });
});
