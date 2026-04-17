import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  prisma: {
    paper: {
      findUnique: vi.fn(),
    },
    reference: {
      count: vi.fn(),
    },
  },
  cleanJsonResponse: vi.fn((text: string) => text),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: hoisted.prisma,
}));

vi.mock("@/lib/llm/proxy-settings", () => ({
  getProxyConfig: vi.fn(),
}));

vi.mock("@/lib/llm/provider", () => ({
  truncateText: vi.fn((text: string) => text),
  MAX_PAPER_CHARS: 30_000,
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
  GrobidCitationMentionExtractor: vi.fn(),
}));

vi.mock("@/lib/references/extractors/llm", () => ({
  mapLlmReferencesToCandidates: vi.fn(),
}));

vi.mock("@/lib/references/persist", () => ({
  persistExtractedReferences: vi.fn(),
}));

vi.mock("@/lib/citations/citation-mention-service", () => ({
  createCitationMentions: vi.fn(),
  applyLegacyCitationContexts: vi.fn(),
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
import { processCitationContextsResult } from "../batch";

describe("processCitationContextsResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.cleanJsonResponse.mockImplementation((text: string) => text);
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
    const createMentions = vi.fn().mockResolvedValue({ created: 1, unmatched: 0 });
    const applyLegacyContexts = vi.fn().mockResolvedValue(1);

    await processCitationContextsResult("paper-1", "[]", {
      grobidExtract,
      createMentions,
      applyLegacyContexts,
    });

    expect(grobidExtract).toHaveBeenCalledWith("/tmp/paper-1.pdf");
    expect(createMentions).toHaveBeenCalledWith(
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
    expect(applyLegacyContexts).toHaveBeenCalledWith("paper-1", [
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

    const createMentions = vi.fn().mockResolvedValue({ created: 1, unmatched: 0 });
    const applyLegacyContexts = vi.fn().mockResolvedValue(1);

    await processCitationContextsResult(
      "paper-2",
      JSON.stringify([
        {
          citation: "Vaswani et al., 2017",
          context: "The transformer (Vaswani et al., 2017) changed NLP.",
        },
      ]),
      {
        createMentions,
        applyLegacyContexts,
      },
    );

    expect(createMentions).toHaveBeenCalledWith(
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
    expect(applyLegacyContexts).toHaveBeenCalledWith("paper-2", [
      {
        citationText: "Vaswani et al., 2017",
        excerpt: "The transformer (Vaswani et al., 2017) changed NLP.",
      },
    ]);
  });
});
