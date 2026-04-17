import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    paper: {
      findMany: vi.fn(),
    },
    promptResult: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../../llm/proxy-settings", () => ({
  getProxyConfig: vi.fn().mockResolvedValue({
    enabled: true,
    anthropicBaseUrl: "https://proxy.example",
    modelId: "claude-haiku-4-5",
    headerName: "x-test-proxy",
    headerValue: "secret",
  }),
}));

vi.mock("../../references/extraction", () => ({
  extractReferenceCandidates: vi.fn(),
}));

vi.mock("../../references/persist", () => ({
  persistExtractedReferences: vi.fn(),
}));

import { prisma } from "../../prisma";
import { extractReferenceCandidates } from "../../references/extraction";
import { persistExtractedReferences } from "../../references/persist";
import { runHybridReferenceExtractionForPapers } from "../../references/batch-reference-extraction";

describe("runHybridReferenceExtractionForPapers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(persistExtractedReferences).mockResolvedValue({
      storedReferences: 1,
      promotedPaperEdges: 0,
      promotedEntityAssertions: 0,
      titleHintMatches: 0,
    });
  });

  it("persists GROBID results without saving a prompt result", async () => {
    vi.mocked(prisma.paper.findMany).mockResolvedValue([
      {
        id: "paper-1",
        userId: "user-1",
        entityId: "entity-1",
        filePath: "/tmp/paper-1.pdf",
        fullText: "Full paper text",
      },
    ] as never);
    vi.mocked(extractReferenceCandidates).mockResolvedValue({
      candidates: [
        {
          referenceIndex: 1,
          rawCitation: "Attention Is All You Need",
          title: "Attention Is All You Need",
          authors: ["Ashish Vaswani"],
          year: 2017,
          venue: "NeurIPS",
          doi: "10.5555/3295222.3295349",
          arxivId: null,
          extractionMethod: "grobid_tei",
          extractionConfidence: 0.95,
        },
      ],
      method: "grobid_tei",
      status: "succeeded",
      extractorVersion: "grobid_v1",
      attempts: [
        {
          method: "grobid_tei",
          status: "succeeded",
          candidateCount: 1,
          preflightResult: "text_layer_ok",
          pageCount: 12,
        },
      ],
    });

    const result = await runHybridReferenceExtractionForPapers(
      ["paper-1"],
      "claude-haiku-4-5",
    );

    expect(extractReferenceCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        paperId: "paper-1",
        filePath: "/tmp/paper-1.pdf",
        provider: "proxy",
        modelId: "claude-haiku-4-5",
      }),
    );
    expect(prisma.promptResult.create).not.toHaveBeenCalled();
    expect(persistExtractedReferences).toHaveBeenCalledWith(
      expect.objectContaining({
        paperId: "paper-1",
        provenance: "grobid_tei",
        extractorVersion: "grobid_v1",
      }),
    );
    expect(result).toEqual({
      persistedPapers: 1,
      grobidPapers: 1,
      llmFallbackPapers: 0,
      failedPapers: 0,
    });
  });

  it("records prompt results when the batch path falls back to the LLM extractor", async () => {
    vi.mocked(prisma.paper.findMany).mockResolvedValue([
      {
        id: "paper-2",
        userId: "user-2",
        entityId: "entity-2",
        filePath: null,
        fullText: "Fallback paper text",
      },
    ] as never);
    vi.mocked(extractReferenceCandidates).mockResolvedValue({
      candidates: [
        {
          referenceIndex: 1,
          rawCitation: "Scaling Laws for Neural Language Models",
          title: "Scaling Laws for Neural Language Models",
          authors: ["Jared Kaplan"],
          year: 2020,
          venue: "arXiv",
          doi: null,
          arxivId: "2001.08361",
          extractionMethod: "llm_repair",
          extractionConfidence: 0.55,
        },
      ],
      method: "llm_repair",
      status: "succeeded",
      extractorVersion: "llm_v1",
      llmRawResponse: '[{"title":"Scaling Laws for Neural Language Models"}]',
      fallbackReason: "paper has no PDF file path",
      attempts: [
        {
          method: "grobid_tei",
          status: "failed",
          candidateCount: 0,
          errorSummary: "paper has no PDF file path",
        },
        {
          method: "llm_repair",
          status: "succeeded",
          candidateCount: 1,
        },
      ],
    });
    vi.mocked(prisma.promptResult.create).mockResolvedValue({ id: "prompt-1" } as never);

    const result = await runHybridReferenceExtractionForPapers(
      ["paper-2"],
      "claude-haiku-4-5",
    );

    expect(prisma.promptResult.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paperId: "paper-2",
        promptType: "extractReferences",
        provider: "proxy",
        model: "claude-haiku-4-5",
      }),
    });
    expect(persistExtractedReferences).toHaveBeenCalledWith(
      expect.objectContaining({
        paperId: "paper-2",
        provenance: "llm_extraction",
        extractorVersion: "llm_v1",
      }),
    );
    expect(result).toEqual({
      persistedPapers: 1,
      grobidPapers: 0,
      llmFallbackPapers: 1,
      failedPapers: 0,
    });
  });
});
