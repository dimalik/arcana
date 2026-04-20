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

describe("POST /api/papers/[id]/llm/timeline", () => {
  it("persists a sparse-claim fallback payload through the shared engine", async () => {
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
      timeline: [],
      narrative:
        "There are not enough citation-anchored claims across the cluster to build an honest timeline yet.",
      openQuestions: [],
    });
    hoisted.promptResultCreate.mockImplementation(async ({ data }) => ({
      id: "prompt-1",
      ...data,
      createdAt: "2026-04-20T00:00:00.000Z",
    }));

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/llm/timeline", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        promptType: "buildTimeline",
        result: JSON.stringify({
          timeline: [],
          narrative:
            "There are not enough citation-anchored claims across the cluster to build an honest timeline yet.",
          openQuestions: [],
        }),
      }),
    );
  });
});
