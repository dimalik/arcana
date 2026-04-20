import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  resolveModelConfig: vi.fn(),
  runCrossPaperAnalysisCapability: vi.fn(),
  promptResultCreate: vi.fn(),
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
  paperAccessErrorToResponse: vi.fn(() => null),
}));

vi.mock("@/lib/llm/auto-process", () => ({
  resolveModelConfig: hoisted.resolveModelConfig,
}));

vi.mock("@/lib/papers/analysis", () => ({
  runCrossPaperAnalysisCapability: hoisted.runCrossPaperAnalysisCapability,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promptResult: {
      create: hoisted.promptResultCreate,
    },
  },
}));

import { POST } from "./route";

describe("POST /api/papers/[id]/llm/compare-methodologies", () => {
  it("uses the shared engine for a normal comparison cluster", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: { id: "paper-1" },
    });
    hoisted.resolveModelConfig.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-test",
      proxyConfig: null,
    });
    hoisted.runCrossPaperAnalysisCapability.mockResolvedValue({
      comparison: {
        papers: [
          {
            paperId: "paper-1",
            title: "Seed paper",
            approach: "Retriever-reranker stack",
            datasets: ["MS MARCO"],
            metrics: ["MRR@10"],
            baselines: ["BM25"],
            keyResults: "Improves over BM25 on MS MARCO.",
          },
        ],
        commonDatasets: ["MS MARCO"],
        commonMetrics: ["MRR@10"],
        headToHead: [],
      },
      methodologicalDifferences: [
        {
          aspect: "Retriever",
          description: "One paper uses dense retrieval, the other lexical.",
          implication: "Candidate coverage differs substantially.",
        },
      ],
      verdict: "The dense retriever is stronger on recall-sensitive setups.",
    });
    hoisted.promptResultCreate.mockImplementation(async ({ data }) => ({
      id: "prompt-1",
      ...data,
      createdAt: "2026-04-20T00:00:00.000Z",
    }));

    const response = await POST(
      new NextRequest(
        "http://localhost/api/papers/paper-1/llm/compare-methodologies",
        {
          method: "POST",
          body: JSON.stringify({ paperIds: ["paper-2", "paper-3"] }),
        },
      ),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    expect(hoisted.runCrossPaperAnalysisCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "compare_methodologies",
        paperId: "paper-1",
        relatedPaperIds: ["paper-2", "paper-3"],
      }),
    );

    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        promptType: "compareMethodologies",
      }),
    );
  });
});
