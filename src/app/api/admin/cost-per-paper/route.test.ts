import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  prisma: {
    llmUsageLog: {
      findMany: vi.fn(),
    },
    agentSession: {
      findMany: vi.fn(),
    },
    researchProject: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: hoisted.prisma,
}));

vi.mock("@/lib/usage", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/usage")>("../../../../lib/usage");
  return actual;
});

vi.mock("@/lib/paper-costs", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/paper-costs")>("../../../../lib/paper-costs");
  return actual;
});

import { GET } from "./route";

describe("GET /api/admin/cost-per-paper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a reconciled union of provider-mediated and paper-agent cost", async () => {
    hoisted.prisma.llmUsageLog.findMany.mockResolvedValue([
      {
        operation: "processing_summarize",
        modelId: "gpt-4o-mini",
        estimatedCostUsd: 0.25,
        inputTokens: 1000,
        outputTokens: 500,
        metadata: JSON.stringify({
          runtime: "processing",
          source: "auto_process",
          paperId: "paper-1",
          step: "summarize",
        }),
      },
      {
        operation: "figure-extraction",
        modelId: "gpt-4o-mini",
        estimatedCostUsd: 0.10,
        inputTokens: 300,
        outputTokens: 100,
        metadata: JSON.stringify({
          projectId: "project-1",
        }),
      },
      {
        operation: "paper_chat",
        modelId: "gpt-4o-mini",
        estimatedCostUsd: 0.40,
        inputTokens: 1200,
        outputTokens: 800,
        metadata: JSON.stringify({
          paperId: "paper-2",
          runtime: "interactive",
        }),
      },
      {
        operation: "processing_extractCitationContexts",
        modelId: "claude-sonnet-4-6",
        estimatedCostUsd: 0.55,
        inputTokens: 2000,
        outputTokens: 900,
        metadata: JSON.stringify({
          runtime: "processing",
          source: "batch",
          paperId: "paper-2",
          step: "extractCitationContexts",
        }),
      },
      {
        operation: "mystery_paper_operation",
        modelId: "gpt-4o",
        estimatedCostUsd: 0.20,
        inputTokens: 600,
        outputTokens: 200,
        metadata: JSON.stringify({
          paperId: "paper-3",
        }),
      },
    ]);
    hoisted.prisma.agentSession.findMany.mockResolvedValue([
      {
        paperId: "paper-2",
        costUsd: 1.2,
      },
      {
        paperId: "paper-4",
        costUsd: 0.8,
      },
    ]);
    hoisted.prisma.researchProject.findMany.mockResolvedValue([
      { id: "project-1", title: "Project One" },
    ]);

    const response = await GET(new NextRequest("http://localhost/api/admin/cost-per-paper?days=30"));
    const body = await response.json();

    expect(body.paperProcessing).toEqual({
      totalCost: 0.25,
      processedPapers: 1,
      avgCostPerPaper: 0.25,
      byModel: {
        "gpt-4o-mini": {
          calls: 1,
          cost: 0.25,
          inputTokens: 1000,
          outputTokens: 500,
        },
      },
    });
    expect(body.paperCosts).toEqual({
      totalCost: 3.4,
      paperCount: 4,
      avgCostPerPaper: 0.85,
      byModel: {
        "gpt-4o-mini": {
          calls: 2,
          cost: 0.65,
          inputTokens: 2200,
          outputTokens: 1300,
        },
        "claude-sonnet-4-6": {
          calls: 1,
          cost: 0.55,
          inputTokens: 2000,
          outputTokens: 900,
        },
        "gpt-4o": {
          calls: 1,
          cost: 0.2,
          inputTokens: 600,
          outputTokens: 200,
        },
      },
      bySegment: {
        processing: { cost: 0.25, records: 1 },
        interactive: { cost: 0.4, records: 1 },
        reference_enrichment: { cost: 0.55, records: 1 },
        agent: { cost: 2, records: 2 },
        unclassified: { cost: 0.2, records: 1 },
      },
      sourceTotals: {
        providerMediated: { cost: 1.4, records: 4 },
        agent: { cost: 2, records: 2 },
        combined: { cost: 3.4, paperCount: 4 },
      },
      unclassifiedOperations: {
        mystery_paper_operation: {
          cost: 0.2,
          calls: 1,
        },
      },
    });
    expect(body.researchProjects).toEqual([
      expect.objectContaining({
        id: "project-1",
        title: "Project One",
        totalCost: 0.1,
        totalCalls: 1,
      }),
    ]);
  });
});
