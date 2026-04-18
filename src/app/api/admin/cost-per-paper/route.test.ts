import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  prisma: {
    llmUsageLog: {
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

import { GET } from "./route";

describe("GET /api/admin/cost-per-paper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reconstructs processing cost from persisted runtime metadata instead of operation heuristics", async () => {
    hoisted.prisma.llmUsageLog.findMany.mockResolvedValue([
      {
        operation: "unknown",
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
        operation: "unknown",
        modelId: "gpt-4o-mini",
        estimatedCostUsd: 0.40,
        inputTokens: 1200,
        outputTokens: 800,
        metadata: JSON.stringify({
          paperId: "paper-2",
        }),
      },
      {
        operation: "processing_extract",
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
    ]);
    hoisted.prisma.researchProject.findMany.mockResolvedValue([
      { id: "project-1", title: "Project One" },
    ]);

    const response = await GET(new NextRequest("http://localhost/api/admin/cost-per-paper?days=30"));
    const body = await response.json();

    expect(body.paperProcessing).toEqual({
      totalCost: 0.8,
      processedPapers: 2,
      avgCostPerPaper: 0.4,
      byModel: {
        "gpt-4o-mini": {
          calls: 1,
          cost: 0.25,
          inputTokens: 1000,
          outputTokens: 500,
        },
        "claude-sonnet-4-6": {
          calls: 1,
          cost: 0.55,
          inputTokens: 2000,
          outputTokens: 900,
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
