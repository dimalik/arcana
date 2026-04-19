import { describe, expect, it } from "vitest";

import { aggregatePaperCosts } from "./paper-costs";

describe("aggregatePaperCosts", () => {
  it("reconciles provider logs, agent sessions, and unclassified operations", () => {
    const result = aggregatePaperCosts({
      providerLogs: [
        {
          operation: "processing_summarize",
          modelId: "gpt-4o-mini",
          estimatedCostUsd: 0.25,
          inputTokens: 1000,
          outputTokens: 500,
          metadata: JSON.stringify({
            paperId: "paper-1",
            runtime: "processing",
          }),
        },
        {
          operation: "paper_chat",
          modelId: "gpt-4o-mini",
          estimatedCostUsd: 0.4,
          inputTokens: 1200,
          outputTokens: 800,
          metadata: JSON.stringify({
            paperId: "paper-2",
            runtime: "interactive",
          }),
        },
        {
          operation: "processing_extractReferences",
          modelId: "claude-sonnet-4-6",
          estimatedCostUsd: 0.55,
          inputTokens: 2000,
          outputTokens: 900,
          metadata: JSON.stringify({
            paperId: "paper-2",
            runtime: "processing",
          }),
        },
        {
          operation: "mystery_paper_operation",
          modelId: "gpt-4o",
          estimatedCostUsd: 0.2,
          inputTokens: 600,
          outputTokens: 200,
          metadata: JSON.stringify({
            paperId: "paper-3",
          }),
        },
        {
          operation: "paper_chat",
          modelId: "gpt-4o-mini",
          estimatedCostUsd: 0.99,
          inputTokens: 100,
          outputTokens: 100,
          metadata: JSON.stringify({
            projectId: "project-only",
          }),
        },
      ],
      agentSessions: [
        { paperId: "paper-2", costUsd: 1.2 },
        { paperId: "paper-4", costUsd: 0.8 },
      ],
    });

    expect(result.paperCosts.totalCost).toBeCloseTo(3.4, 6);
    expect(result.paperCosts.paperCount).toBe(4);
    expect(result.paperCosts.avgCostPerPaper).toBeCloseTo(0.85, 6);
    expect(result.paperCosts.bySegment).toEqual({
      processing: { cost: 0.25, records: 1 },
      interactive: { cost: 0.4, records: 1 },
      reference_enrichment: { cost: 0.55, records: 1 },
      agent: { cost: 2, records: 2 },
      unclassified: { cost: 0.2, records: 1 },
    });
    expect(result.paperCosts.sourceTotals).toEqual({
      providerMediated: { cost: 1.4, records: 4 },
      agent: { cost: 2, records: 2 },
      combined: { cost: 3.4, paperCount: 4 },
    });
    expect(result.paperCosts.unclassifiedOperations).toEqual({
      mystery_paper_operation: { cost: 0.2, calls: 1 },
    });
    expect(result.paperProcessing).toEqual({
      totalCost: 0.25,
      processedPapers: 1,
      avgCostPerPaper: 0.25,
      byModel: {
        "gpt-4o-mini": {
          cost: 0.25,
          calls: 1,
          inputTokens: 1000,
          outputTokens: 500,
        },
      },
    });
  });
});
