import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperClaimView } from "../analysis/store";

const hoisted = vi.hoisted(() => ({
  paperFigureFindMany: vi.fn(),
  generateStructuredObject: vi.fn(),
  withPaperLlmContext: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paperFigure: {
      findMany: hoisted.paperFigureFindMany,
    },
  },
}));

vi.mock("@/lib/llm/provider", () => ({
  generateStructuredObject: hoisted.generateStructuredObject,
}));

vi.mock("@/lib/llm/paper-llm-context", () => ({
  PAPER_INTERACTIVE_LLM_OPERATIONS: {
    CHAT_AGENT_PLAN: "paper_chat_agent_plan",
  },
  withPaperLlmContext: hoisted.withPaperLlmContext,
}));

import { preparePaperAgentEvidence } from "./agent";

function makePaper(overrides: Partial<Parameters<typeof preparePaperAgentEvidence>[0]["paper"]> = {}) {
  const claims: PaperClaimView[] = [
    {
      id: "claim-1",
      paperId: "paper-1",
      runId: "run-1",
      claimType: null,
      rhetoricalRole: "RESULT",
      facet: "RESULT",
      polarity: "ASSERTIVE",
      stance: null,
      evaluationContext: null,
      text: "The method improves accuracy by 4.2 points on the benchmark.",
      normalizedText: "the method improves accuracy by 4.2 points on the benchmark",
      confidence: 0.94,
      sectionLabel: "Results",
      sectionPath: "results",
      sourceExcerpt: "The method improves accuracy by 4.2 points on the benchmark.",
      excerptHash: "hash-1",
      sourceSpan: null,
      citationAnchors: [],
      evidenceType: "PRIMARY",
      orderIndex: 0,
      createdAt: new Date("2026-04-21T00:00:00Z"),
    },
  ];

  return {
    id: "paper-1",
    title: "Seed Paper",
    year: 2024,
    abstract: "This paper studies a new method.",
    summary: [
      "## Summary",
      "Short overview.",
      "",
      "## Methodology",
      "We introduce an efficient training recipe.",
      "",
      "## Results",
      "The method improves accuracy by 4.2 points on the main benchmark and wins the ablation study.",
    ].join("\n"),
    keyFindings: JSON.stringify(["Improves accuracy by 4.2 points."]),
    fullText: null,
    claims,
    ...overrides,
  };
}

describe("preparePaperAgentEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.withPaperLlmContext.mockImplementation(async (_context, callback) => callback());
  });

  it("reads results and opens a matching table artifact", async () => {
    hoisted.paperFigureFindMany.mockResolvedValue([
      {
        id: "fig-table-1",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Table 1",
        captionText: "Table 1: Main benchmark results.",
        captionSource: "html",
        description: "<table><tr><td>Accuracy</td><td>91.2</td></tr></table>",
        sourceMethod: "html",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "high",
        imagePath: null,
        assetHash: null,
        pdfPage: 6,
        sourcePage: 6,
        figureIndex: 1,
        bbox: null,
        type: "table",
        parentFigureId: null,
        isPrimaryExtraction: true,
        width: null,
        height: null,
        gapReason: null,
        imageSourceMethod: null,
        createdAt: new Date("2026-04-21T00:00:00Z"),
      },
    ]);
    hoisted.generateStructuredObject
      .mockResolvedValueOnce({
        object: { type: "read_section", section: "results" },
      })
      .mockResolvedValueOnce({
        object: { type: "inspect_table", target: "Table 1", query: "accuracy benchmark" },
      })
      .mockResolvedValueOnce({
        object: { type: "finish", answerPlan: "Ground the answer in the results text and table." },
      });

    const result = await preparePaperAgentEvidence({
      paper: makePaper(),
      question: "What were the main benchmark results? Show me the table.",
      intent: "results",
      selectedText: null,
      provider: "openai",
      modelId: "gpt-test",
    });

    expect(result.citations.some((citation) => citation.sectionPath === "results")).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["RESULT_SUMMARY", "TABLE_CARD"]),
    );
    expect(result.actions[0]).toMatchObject({
      phase: "retrieve",
      tool: "read_section",
      source: "planner",
    });
    expect(result.actions[1]).toMatchObject({
      phase: "inspect",
      tool: "inspect_table",
      source: "planner",
      artifactsAdded: 1,
    });
    const tableArtifact = result.artifacts.find((artifact) => artifact.kind === "TABLE_CARD");
    expect(tableArtifact).toBeDefined();
    const payload = JSON.parse(tableArtifact!.payloadJson) as {
      table?: {
        columns?: string[];
        rows?: string[][];
        matches?: Array<{ rowIndex: number; values: string[] }>;
      } | null;
    };
    expect(payload.table?.columns).toEqual(["Column 1", "Column 2"]);
    expect(payload.table?.rows?.[0]).toEqual(["Accuracy", "91.2"]);
    expect(payload.table?.matches?.[0]?.values).toEqual(["Accuracy", "91.2"]);
  });

  it("opens a matching figure artifact by label", async () => {
    hoisted.paperFigureFindMany.mockResolvedValue([
      {
        id: "fig-2",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Figure 2",
        captionText: "Figure 2: Model architecture.",
        captionSource: "html",
        description: "Architecture overview.",
        sourceMethod: "html",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "high",
        imagePath: "uploads/figures/paper-1/figure-2.png",
        assetHash: null,
        pdfPage: 3,
        sourcePage: 3,
        figureIndex: 2,
        bbox: null,
        type: "figure",
        parentFigureId: null,
        isPrimaryExtraction: true,
        width: 1200,
        height: 800,
        gapReason: null,
        imageSourceMethod: "html",
        createdAt: new Date("2026-04-21T00:00:00Z"),
      },
    ]);
    hoisted.generateStructuredObject
      .mockResolvedValueOnce({
        object: { type: "open_figure", target: "Figure 2" },
      })
      .mockResolvedValueOnce({
        object: { type: "finish", answerPlan: "Explain the architecture shown in Figure 2." },
      });

    const result = await preparePaperAgentEvidence({
      paper: makePaper(),
      question: "Show me Figure 2 and explain it.",
      intent: "figures",
      selectedText: null,
      provider: "openai",
      modelId: "gpt-test",
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.kind).toBe("FIGURE_CARD");
    expect(result.citations[0]?.snippet).toContain("Figure 2");
    expect(result.actions[0]).toMatchObject({
      phase: "inspect",
      tool: "open_figure",
      source: "planner",
      artifactsAdded: 1,
    });
  });

  it("generates a code snippet artifact for implementation-style questions", async () => {
    hoisted.paperFigureFindMany.mockResolvedValue([]);
    hoisted.generateStructuredObject
      .mockResolvedValueOnce({
        object: { type: "read_section", section: "methodology" },
      })
      .mockResolvedValueOnce({
        object: { type: "search_claims", query: "training recipe", limit: 2 },
      })
      .mockResolvedValueOnce({
        object: { type: "finish", answerPlan: "Provide a derived implementation sketch." },
      })
      .mockResolvedValueOnce({
        object: {
          summary: "Derived PyTorch sketch for the training recipe.",
          filename: "seed_paper_recipe.py",
          language: "python",
          code: "def train_step(batch):\n    return batch\n",
          assumptions: ["Optimizer details were not specified in the paper excerpt."],
        },
      });

    const result = await preparePaperAgentEvidence({
      paper: makePaper(),
      question: "Generate a code snippet for the method in this paper.",
      intent: "code",
      selectedText: null,
      provider: "openai",
      modelId: "gpt-test",
    });

    expect(result.artifacts.map((artifact) => artifact.kind)).toContain("CODE_SNIPPET");
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "Generate code snippet",
          phase: "synthesize",
          tool: "generate_code_snippet",
          source: "system",
          artifactsAdded: 1,
        }),
      ]),
    );
  });
});
