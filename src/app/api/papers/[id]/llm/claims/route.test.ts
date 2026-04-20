import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  resolveModelConfig: vi.fn(),
  runPaperAnalysisCapability: vi.fn(),
  getLatestCompletedPaperClaimRun: vi.fn(),
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
  paperAccessErrorToResponse: vi.fn(() => null),
  jsonWithDuplicateState: vi.fn((access, data, init, options) => {
    const body =
      options?.includeBodyState && data && typeof data === "object" && !Array.isArray(data)
        ? {
            ...data,
            duplicateState: access.duplicateState,
            collapsedIntoPaperId: access.collapsedIntoPaperId,
          }
        : data;
    const response = Response.json(body, init);
    return access.setDuplicateStateHeaders(response);
  }),
}));

vi.mock("@/lib/llm/auto-process", () => ({
  resolveModelConfig: hoisted.resolveModelConfig,
}));

vi.mock("@/lib/papers/analysis", () => ({
  runPaperAnalysisCapability: hoisted.runPaperAnalysisCapability,
  getLatestCompletedPaperClaimRun: hoisted.getLatestCompletedPaperClaimRun,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import { GET, POST } from "./route";

describe("paper claims route", () => {
  it("returns the latest completed run with duplicate-state headers", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      duplicateState: "hidden",
      collapsedIntoPaperId: null,
      paper: { id: "paper-1" },
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "hidden");
        return response;
      },
    });
    hoisted.getLatestCompletedPaperClaimRun.mockResolvedValue({
      id: "run-1",
      extractorVersion: "paper-claims-v1",
      status: "COMPLETED",
      sourceTextHash: "hash-1",
      createdAt: "2026-04-20T00:00:00.000Z",
      completedAt: "2026-04-20T00:00:30.000Z",
      claims: [],
    });

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1/llm/claims"),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    expect(response.headers.get("X-Paper-Duplicate-State")).toBe("hidden");
    expect(await response.json()).toEqual(
      expect.objectContaining({
        paperId: "paper-1",
        duplicateState: "hidden",
        run: expect.objectContaining({ id: "run-1" }),
      }),
    );
  });

  it("runs claim extraction through the shared capability", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: {
        id: "paper-1",
        title: "Paper",
        fullText: "Full text",
        abstract: null,
      },
    });
    hoisted.resolveModelConfig.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-test",
      proxyConfig: null,
    });
    hoisted.runPaperAnalysisCapability.mockResolvedValue({
      cached: false,
      run: { id: "run-1" },
      claims: [{ id: "claim-1" }],
    });

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/llm/claims", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      }),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    expect(hoisted.runPaperAnalysisCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "claims",
        paperId: "paper-1",
        userId: "user-1",
        force: true,
      }),
    );
    expect(await response.json()).toEqual(
      expect.objectContaining({
        cached: false,
        claims: [{ id: "claim-1" }],
      }),
    );
  });
});
