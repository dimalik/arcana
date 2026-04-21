import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const hoisted = vi.hoisted(() => ({
  paperFindUnique: vi.fn(),
  paperFindMany: vi.fn(),
  conversationFindUnique: vi.fn(),
  runPaperAnalysisCapability: vi.fn(),
  runCrossPaperAnalysisCapability: vi.fn(),
  getLatestCompletedPaperClaimRun: vi.fn(),
  preparePaperAgentEvidence: vi.fn(),
  createConversationArtifact: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paper: {
      findUnique: hoisted.paperFindUnique,
      findMany: hoisted.paperFindMany,
    },
    conversation: {
      findUnique: hoisted.conversationFindUnique,
    },
  },
}));

vi.mock("../analysis/capability", () => ({
  runPaperAnalysisCapability: hoisted.runPaperAnalysisCapability,
}));

vi.mock("../analysis/cross-paper-engine", () => ({
  runCrossPaperAnalysisCapability: hoisted.runCrossPaperAnalysisCapability,
}));

vi.mock("../analysis/store", () => ({
  getLatestCompletedPaperClaimRun: hoisted.getLatestCompletedPaperClaimRun,
  createConversationArtifact: hoisted.createConversationArtifact,
}));

vi.mock("./agent", () => ({
  preparePaperAgentEvidence: hoisted.preparePaperAgentEvidence,
}));

import { preparePaperAnswer } from "./index";

function makePaper() {
  return {
    id: "paper-1",
    title: "Seed Paper",
    year: 2024,
    abstract: "This paper reports benchmark results for a new method.",
    summary: [
      "## Summary",
      "Overview.",
      "",
      "## Results",
      "The method improves accuracy by 4.2 points.",
    ].join("\n"),
    keyFindings: JSON.stringify(["Improves accuracy by 4.2 points."]),
    fullText: "Results\nThe method improves accuracy by 4.2 points.",
  };
}

describe("preparePaperAnswer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.paperFindUnique.mockResolvedValue(makePaper());
    hoisted.paperFindMany.mockResolvedValue([]);
    hoisted.conversationFindUnique.mockResolvedValue(null);
    hoisted.getLatestCompletedPaperClaimRun.mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("does not preload claim extraction for simple results questions", async () => {
    hoisted.preparePaperAgentEvidence.mockResolvedValue({
      citations: [
        {
          paperId: "paper-1",
          paperTitle: "Seed Paper",
          snippet: "The method improves accuracy by 4.2 points.",
          sectionPath: "results",
          sourceKind: "summary",
        },
      ],
      artifacts: [],
      actions: [],
    });

    const result = await preparePaperAnswer({
      paperId: "paper-1",
      question: "Tell me about the results",
      provider: "proxy",
      modelId: "claude-sonnet-4-6",
    });

    expect(hoisted.runPaperAnalysisCapability).not.toHaveBeenCalled();
    expect(hoisted.preparePaperAgentEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        paper: expect.objectContaining({
          id: "paper-1",
          claims: [],
        }),
        intent: "results",
      }),
    );
    expect(result.citations[0]?.sectionPath).toBe("results");
  });

  it("degrades to summary evidence when claims extraction fails", async () => {
    hoisted.runPaperAnalysisCapability.mockRejectedValue(
      new Error("upstream failed"),
    );
    hoisted.preparePaperAgentEvidence.mockRejectedValue(
      new Error("agent fallback"),
    );

    const result = await preparePaperAnswer({
      paperId: "paper-1",
      question: "What are the key claims?",
      provider: "proxy",
      modelId: "claude-sonnet-4-6",
    });

    expect(hoisted.runPaperAnalysisCapability).toHaveBeenCalledTimes(1);
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paperId: "paper-1",
          sourceKind: "summary",
        }),
      ]),
    );
  });

  it("forbids paper-specific speculation in grounded answer prompts", async () => {
    hoisted.preparePaperAgentEvidence.mockResolvedValue({
      citations: [
        {
          paperId: "paper-1",
          paperTitle: "Seed Paper",
          snippet: "Table 4 reports the in-house RAI benchmark results.",
          sectionPath: "results",
          sourceKind: "summary",
        },
      ],
      artifacts: [
        {
          kind: "TABLE_CARD",
          title: "Table 4",
          payloadJson: JSON.stringify({
            figureLabel: "Table 4",
            captionText: "Table 4: Safety / RAI results.",
            table: {
              columns: ["Metric", "phi-3-mini"],
              rows: [["Ungroundedness", "0.603"]],
              matches: [{ rowIndex: 0, score: 3, values: ["Ungroundedness", "0.603"] }],
            },
          }),
        },
      ],
      actions: [],
    });

    const result = await preparePaperAnswer({
      paperId: "paper-1",
      question: "Tell me about the RAI results.",
      provider: "proxy",
      modelId: "claude-sonnet-4-6",
    });

    expect(result.systemPrompt).toContain("Do not use outside knowledge to fill paper-specific gaps.");
    expect(result.systemPrompt).toContain("Never write phrases like \"likely\", \"probably\", \"the paper likely covers\", or \"based on general knowledge\".");
    expect(result.systemPrompt).toContain("A matching table artifact is attached. Answer from its matched rows and visible columns before using summary text.");
  });
});
