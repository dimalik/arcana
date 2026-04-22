import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperClaimView } from "../analysis/store";

const hoisted = vi.hoisted(() => ({
  paperFigureFindMany: vi.fn(),
  generateStructuredObject: vi.fn(),
  streamLLMResponse: vi.fn(),
  withPaperLlmContext: vi.fn(),
  readFile: vi.fn(),
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
  streamLLMResponse: hoisted.streamLLMResponse,
}));

vi.mock("@/lib/llm/paper-llm-context", () => ({
  PAPER_INTERACTIVE_LLM_OPERATIONS: {
    CHAT_AGENT_PLAN: "paper_chat_agent_plan",
    CHAT_AGENT_CODE: "paper_chat_agent_code",
    CHAT_AGENT_FIGURE: "paper_chat_agent_figure",
  },
  withPaperLlmContext: hoisted.withPaperLlmContext,
}));

vi.mock("fs/promises", () => ({
  readFile: hoisted.readFile,
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
    vi.resetAllMocks();
    hoisted.withPaperLlmContext.mockImplementation(async (_context, callback) => callback());
    hoisted.streamLLMResponse.mockResolvedValue({
      text: Promise.resolve("{\"found\":false,\"matches\":[],\"note\":null}"),
    });
    hoisted.readFile.mockResolvedValue(Buffer.from("image-bytes"));
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
      source: "fallback",
    });
    expect(result.actions[1]).toMatchObject({
      phase: "inspect",
      tool: "inspect_table",
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

  it("attaches the focused result packet for focused result questions", async () => {
    hoisted.paperFigureFindMany.mockResolvedValue([
      {
        id: "fig-table-1",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Table 1",
        captionText: "Table 1: Comparison results on RepoQA benchmark.",
        captionSource: "html",
        description:
          "<table><tr><th>Language</th><th>Pass@1</th></tr><tr><td>Python</td><td>52.0</td></tr></table>",
        sourceMethod: "html",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "high",
        imagePath: null,
        assetHash: null,
        pdfPage: 5,
        sourcePage: 5,
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
      {
        id: "fig-table-3",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Table 3",
        captionText: "Table 3: Core benchmark comparisons.",
        captionSource: "html",
        description:
          "<table><tr><th>Benchmark</th><th>Phi-3-mini</th></tr><tr><td>MMLU</td><td>78.2</td></tr></table>",
        sourceMethod: "html",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "high",
        imagePath: null,
        assetHash: null,
        pdfPage: 6,
        sourcePage: 6,
        figureIndex: 3,
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
      {
        id: "fig-table-4",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Table 4",
        captionText: "Table 4: Safety / RAI results.",
        captionSource: "html",
        description:
          [
            "<div class=\"ltx_logical-block\">",
            "<span class=\"ltx_tabular ltx_align_middle\">",
            "<span class=\"ltx_tr\">",
            "<span class=\"ltx_td\">Metric</span>",
            "<span class=\"ltx_td\">",
            "<span class=\"ltx_tabular ltx_align_middle\">",
            "<span class=\"ltx_tr\"><span class=\"ltx_td\">Phi-3-mini</span></span>",
            "<span class=\"ltx_tr\"><span class=\"ltx_td\">3.8b</span></span>",
            "</span>",
            "</span>",
            "<span class=\"ltx_td\">Llama-3-In 8B</span>",
            "</span>",
            "<span class=\"ltx_tr\">",
            "<span class=\"ltx_td\">Ungroundedness</span>",
            "<span class=\"ltx_td\">0.603</span>",
            "<span class=\"ltx_td\">0.328</span>",
            "</span>",
            "<span class=\"ltx_tr\">",
            "<span class=\"ltx_td\">Jailbreak DR-1</span>",
            "<span class=\"ltx_td\">0.123</span>",
            "<span class=\"ltx_td\">0.114</span>",
            "</span>",
            "</span>",
            "</div>",
          ].join(""),
        sourceMethod: "html",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "high",
        imagePath: null,
        assetHash: null,
        pdfPage: 7,
        sourcePage: 7,
        figureIndex: 4,
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
      {
        id: "fig-5",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Figure 5",
        captionText: "Figure 5: Microsoft AI Red Team evaluation before and after safety alignment.",
        captionSource: "html",
        description: "The harmful response rate decreases after alignment under adversarial red-team conversations.",
        sourceMethod: "html",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "high",
        imagePath: "uploads/figures/paper-1/figure-5.png",
        assetHash: null,
        pdfPage: 8,
        sourcePage: 8,
        figureIndex: 5,
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
        object: { type: "finish", answerPlan: "Answer using the grounded results." },
      });

    const result = await preparePaperAgentEvidence({
      paper: makePaper({
        summary: [
        "## Summary",
        "Short overview.",
        "",
        "## Results",
        "Table 3 compares the core academic benchmarks. Table 4 reports the in-house RAI benchmark results. Figure 5 shows the red-team evaluation after safety alignment.",
      ].join("\n"),
      }),
      question: "Tell me about the RAI results.",
      intent: "results",
      selectedText: null,
      provider: "openai",
      modelId: "gpt-test",
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "read_section",
          source: "fallback",
        }),
        expect.objectContaining({
          tool: "inspect_table",
          source: "fallback",
          input: "Table 4",
          artifactsAdded: 1,
        }),
        expect.objectContaining({
          tool: "inspect_table",
          source: "fallback",
          input: "Table 3",
          artifactsAdded: 1,
        }),
        expect.objectContaining({
          tool: "open_figure",
          source: "fallback",
          input: "Figure 5",
          artifactsAdded: 1,
        }),
      ]),
    );
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      "RESULT_SUMMARY",
      "TABLE_CARD",
      "TABLE_CARD",
      "FIGURE_CARD",
    ]);
    const tableArtifacts = result.artifacts.filter((artifact) => artifact.kind === "TABLE_CARD");
    expect(tableArtifacts).toHaveLength(2);
    expect(tableArtifacts.map((artifact) => artifact.title)).toEqual(["Table 4", "Table 3"]);
    const payload = JSON.parse(tableArtifacts[0]!.payloadJson) as {
      table?: {
        columns?: string[];
        matches?: Array<{ values: string[] }>;
      } | null;
    };
    expect(payload.table?.columns).toEqual([
      "Metric",
      "Phi-3-mini 3.8b",
      "Llama-3-In 8B",
    ]);
    expect(payload.table?.matches?.[0]?.values).toEqual([
      "Ungroundedness",
      "0.603",
      "0.328",
    ]);
    const figureArtifact = result.artifacts.find((artifact) => artifact.kind === "FIGURE_CARD");
    expect(figureArtifact?.title).toBe("Figure 5");
  });

  it("generates a code snippet artifact for implementation-style questions", async () => {
    hoisted.paperFigureFindMany.mockResolvedValue([]);
    hoisted.generateStructuredObject
      .mockResolvedValueOnce({
        object: { type: "read_section", section: "methodology" },
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
      intent: "generated_artifact",
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

  it("hunts exact result evidence across results text and figures for named targets", async () => {
    hoisted.paperFigureFindMany.mockResolvedValue([
      {
        id: "fig-4",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Figure 4",
        captionText: "Figure 4: MMLU-Multilingual performance across supported languages.",
        captionSource: "html",
        description: "",
        sourceMethod: "html",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "high",
        imagePath: "uploads/figures/paper-1/figure-4.png",
        assetHash: null,
        pdfPage: 9,
        sourcePage: 9,
        figureIndex: 4,
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
    hoisted.streamLLMResponse.mockResolvedValue({
      text: Promise.resolve(JSON.stringify({
        found: true,
        matches: [
          {
            text: "Figure 4 shows Ukrainian at 68.4 on the multilingual benchmark.",
            matchedTerms: ["ukrainian", "multilingual"],
          },
        ],
        note: "Recovered exact language-level evidence from the plotted figure.",
      })),
    });

    const result = await preparePaperAgentEvidence({
      paper: makePaper({
        summary: [
          "## Summary",
          "Short overview.",
          "",
          "## Results",
          "Figure 4 reports the MMLU-Multilingual breakdown for supported languages.",
        ].join("\n"),
        fullText: [
          "Evaluation details",
          "We evaluate the multilingual setting on languages such as Arabic, Chinese, Russian, Ukrainian, and Vietnamese, with average MMLU-multilingual scores of 55.4 and 47.3, respectively.",
          "Due to its larger model capacity, phi-3.5-MoE achieves a significantly higher average score of 69.9, outperforming phi-3.5-mini.",
          "Figure 4 compares phi-3-mini, phi-3.5-mini and phi-3.5-MoE on MMLU-Multilingual tasks.",
        ].join("\n"),
      }),
      question: "What were the results on Ukrainian?",
      intent: "results",
      selectedText: null,
      provider: "openai",
      modelId: "gpt-test",
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "read_section",
          source: "fallback",
        }),
        expect.objectContaining({
          tool: "search_passages",
          source: "fallback",
          input: "full_text",
          outputPreview: expect.stringContaining("exact passage"),
        }),
        expect.objectContaining({
          tool: "open_figure",
          source: "fallback",
          input: "Figure 4",
          outputPreview: expect.stringContaining("exact figure match"),
        }),
      ]),
    );
    expect(result.citations.some((citation) => /ukrainian/i.test(citation.snippet))).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["RESULT_SUMMARY", "FIGURE_CARD"]),
    );
    const figureArtifact = result.artifacts.find((artifact) => artifact.kind === "FIGURE_CARD");
    const payload = JSON.parse(figureArtifact!.payloadJson) as {
      matches?: Array<{ text: string }>;
    };
    expect(payload.matches?.[0]?.text).toMatch(/Ukrainian.*68\.4/i);
  });
});
