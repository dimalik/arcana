import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  prisma: {
    paper: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    reference: {
      count: vi.fn(),
    },
  },
  cleanJsonResponse: vi.fn((text: string) => text),
  grobidExtract: vi.fn(),
  createMentions: vi.fn(),
  applyLegacyContexts: vi.fn(),
  generateLLMResponse: vi.fn(),
  setLlmContext: vi.fn(),
  checkGrobidHealth: vi.fn(),
  loadGrobidConfig: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: hoisted.prisma,
}));

vi.mock("@/lib/llm/proxy-settings", () => ({
  getProxyConfig: vi.fn(() => ({
    enabled: true,
    anthropicBaseUrl: "https://proxy.example",
    headerName: "x-proxy",
    headerValue: "token",
    modelId: "claude-haiku-4-5",
  })),
}));

vi.mock("@/lib/llm/provider", () => ({
  truncateText: vi.fn((text: string) => text),
  MAX_PAPER_CHARS: 30_000,
  generateLLMResponse: hoisted.generateLLMResponse,
  setLlmContext: hoisted.setLlmContext,
}));

vi.mock("@/lib/llm/prompts", () => ({
  buildPrompt: vi.fn(() => ({ system: "", prompt: "" })),
  buildDistillPrompt: vi.fn(() => ({ system: "", prompt: "" })),
  cleanJsonResponse: hoisted.cleanJsonResponse,
}));

vi.mock("@/lib/llm/user-context", () => ({
  getUserContext: vi.fn(),
  buildUserContextPreamble: vi.fn(() => ""),
}));

vi.mock("@/lib/references/extract-section", () => ({
  getBodyTextForContextExtraction: vi.fn((text: string) => text),
}));

vi.mock("@/lib/references/batch-reference-extraction", () => ({
  runHybridReferenceExtractionForPapers: vi.fn(),
}));

vi.mock("@/lib/references/grobid/citation-mentions", () => ({
  GrobidCitationMentionExtractor: vi.fn().mockImplementation(() => ({
    extract: hoisted.grobidExtract,
  })),
}));

vi.mock("@/lib/references/grobid/config", () => ({
  loadGrobidConfig: hoisted.loadGrobidConfig,
}));

vi.mock("@/lib/references/grobid/health", () => ({
  checkGrobidHealth: hoisted.checkGrobidHealth,
}));

vi.mock("@/lib/references/extractors/llm", () => ({
  mapLlmReferencesToCandidates: vi.fn(),
}));

vi.mock("@/lib/references/persist", () => ({
  persistExtractedReferences: vi.fn(),
}));

vi.mock("@/lib/citations/citation-mention-service", () => ({
  createCitationMentions: hoisted.createMentions,
  applyLegacyCitationContexts: hoisted.applyLegacyContexts,
}));

vi.mock("@/lib/tags/auto-tag", () => ({
  resolveAndAssignTags: vi.fn(),
  getExistingTagNames: vi.fn(),
  getScoredTagHints: vi.fn(),
}));

vi.mock("@/lib/tags/cleanup", () => ({
  refreshTagScores: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
  processCitationContextsResult,
  runCitationContextSidecarForPapers,
  shouldUseGrobidCitationContextSidecar,
} from "../batch";

describe("processCitationContextsResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.cleanJsonResponse.mockImplementation((text: string) => text);
    hoisted.createMentions.mockResolvedValue({ created: 1, unmatched: 0 });
    hoisted.applyLegacyContexts.mockResolvedValue(1);
    hoisted.loadGrobidConfig.mockReturnValue({ serverUrl: "http://127.0.0.1:8070" });
  });

  it("prefers GROBID structural mentions when a PDF is available", async () => {
    vi.mocked(prisma.paper.findUnique).mockResolvedValue({
      filePath: "/tmp/paper-1.pdf",
    } as never);
    vi.mocked(prisma.reference.count).mockResolvedValue(3 as never);

    const grobidExtract = vi.fn().mockResolvedValue({
      mentions: [
        {
          citationText: "Kaplan et al. (2020)",
          excerpt:
            "Scaling laws improved predictably with size Kaplan et al. (2020).",
          referenceIndex: 15,
          sectionLabel: "1 Introduction",
        },
      ],
    });
    await processCitationContextsResult("paper-1", "[]", {
      grobidExtract,
      createMentions: hoisted.createMentions,
      applyLegacyContexts: hoisted.applyLegacyContexts,
    });

    expect(grobidExtract).toHaveBeenCalledWith("/tmp/paper-1.pdf");
    expect(hoisted.createMentions).toHaveBeenCalledWith(
      "paper-1",
      [
        expect.objectContaining({
          citationText: "Kaplan et al. (2020)",
          referenceIndex: 15,
        }),
      ],
      "grobid_fulltext_v1",
      "grobid_fulltext",
    );
    expect(hoisted.applyLegacyContexts).toHaveBeenCalledWith("paper-1", [
      expect.objectContaining({
        citationText: "Kaplan et al. (2020)",
        referenceIndex: 15,
      }),
    ]);
  });

  it("falls back to the LLM context payload when GROBID is unavailable", async () => {
    vi.mocked(prisma.paper.findUnique).mockResolvedValue({
      filePath: null,
    } as never);
    vi.mocked(prisma.reference.count).mockResolvedValue(2 as never);

    await processCitationContextsResult(
      "paper-2",
      JSON.stringify([
        {
          citation: "Vaswani et al., 2017",
          context: "The transformer (Vaswani et al., 2017) changed NLP.",
        },
      ]),
      {
        createMentions: hoisted.createMentions,
        applyLegacyContexts: hoisted.applyLegacyContexts,
      },
    );

    expect(hoisted.createMentions).toHaveBeenCalledWith(
      "paper-2",
      [
        {
          citationText: "Vaswani et al., 2017",
          excerpt: "The transformer (Vaswani et al., 2017) changed NLP.",
        },
      ],
      "batch_v1",
      "llm_extraction",
    );
    expect(hoisted.applyLegacyContexts).toHaveBeenCalledWith("paper-2", [
      {
        citationText: "Vaswani et al., 2017",
        excerpt: "The transformer (Vaswani et al., 2017) changed NLP.",
      },
    ]);
  });
});

describe("shouldUseGrobidCitationContextSidecar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadGrobidConfig.mockReturnValue({ serverUrl: "http://127.0.0.1:8070" });
  });

  it("returns true when PDF-backed papers exist and GROBID is healthy", async () => {
    hoisted.checkGrobidHealth.mockResolvedValue({ status: "healthy" });

    await expect(
      shouldUseGrobidCitationContextSidecar([
        { fullText: "body", filePath: "/tmp/paper.pdf" },
      ]),
    ).resolves.toBe(true);
  });

  it("returns false when GROBID is unhealthy", async () => {
    hoisted.checkGrobidHealth.mockResolvedValue({ status: "unhealthy" });

    await expect(
      shouldUseGrobidCitationContextSidecar([
        { fullText: "body", filePath: "/tmp/paper.pdf" },
      ]),
    ).resolves.toBe(false);
  });
});

describe("runCitationContextSidecarForPapers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.cleanJsonResponse.mockImplementation((text: string) => text);
    hoisted.createMentions.mockResolvedValue({ created: 1, unmatched: 0 });
    hoisted.applyLegacyContexts.mockResolvedValue(1);
    hoisted.generateLLMResponse.mockResolvedValue(
      JSON.stringify([
        {
          citation: "Vaswani et al., 2017",
          context: "The transformer (Vaswani et al., 2017) changed NLP.",
        },
      ]),
    );
  });

  it("falls back to inline LLM extraction when GROBID sidecar finds no mentions", async () => {
    vi.mocked(prisma.paper.findMany)
      .mockResolvedValueOnce([
        {
          id: "paper-3",
          fullText: "The transformer (Vaswani et al., 2017) changed NLP.",
          userId: "user-1",
        },
      ] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(prisma.paper.findUnique).mockResolvedValue({
      filePath: "/tmp/paper-3.pdf",
    } as never);
    vi.mocked(prisma.reference.count).mockResolvedValue(2 as never);
    hoisted.grobidExtract.mockResolvedValue({
      mentions: [],
      errorSummary: "no structural mentions",
    });

    const result = await runCitationContextSidecarForPapers(
      ["paper-3"],
      "claude-haiku-4-5",
    );

    expect(hoisted.grobidExtract).toHaveBeenCalledWith("/tmp/paper-3.pdf");
    expect(hoisted.generateLLMResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "proxy",
        modelId: "claude-haiku-4-5",
      }),
    );
    expect(result).toEqual({
      grobidPapers: 0,
      llmFallbackPapers: 1,
      failedPapers: 0,
    });
  });
});
