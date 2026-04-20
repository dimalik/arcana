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

describe("POST /api/papers/[id]/llm/gap-finder", () => {
  it("returns 400 when no related papers are available", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: { id: "paper-1" },
    });
    hoisted.resolveModelConfig.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-test",
      proxyConfig: null,
    });
    hoisted.runCrossPaperAnalysisCapability.mockRejectedValue(
      new Error("No related papers found. Run analysis first to link papers."),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/llm/gap-finder", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "No related papers found. Run analysis first to link papers.",
    });
  });
});
