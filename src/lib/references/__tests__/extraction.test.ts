import { describe, expect, it, vi } from "vitest";
import { extractReferenceCandidates } from "../extraction";

describe("extractReferenceCandidates", () => {
  it("prefers GROBID when it yields candidates", async () => {
    const grobidExtract = vi.fn().mockResolvedValue({
      candidates: [
        {
          referenceIndex: 1,
          rawCitation: "Structured ref",
          title: "Structured ref",
          authors: ["Jane Doe"],
          year: 2021,
          venue: "ACL",
          doi: null,
          arxivId: null,
          extractionMethod: "grobid_tei",
          extractionConfidence: 0.9,
        },
      ],
      status: "succeeded",
    });
    const llmExtract = vi.fn();

    const result = await extractReferenceCandidates({
      paperId: "paper-1",
      filePath: "/tmp/paper.pdf",
      fullText: "ignored",
      provider: "openai",
      modelId: "gpt-4o-mini",
      deps: { grobidExtract, llmExtract },
    });

    expect(result.method).toBe("grobid_tei");
    expect(result.extractorVersion).toBe("grobid_v1");
    expect(result.attempts).toEqual([
      expect.objectContaining({
        method: "grobid_tei",
        status: "succeeded",
        candidateCount: 1,
      }),
    ]);
    expect(llmExtract).not.toHaveBeenCalled();
  });

  it("falls back to the LLM when GROBID fails", async () => {
    const grobidExtract = vi.fn().mockResolvedValue({
      candidates: [],
      status: "failed",
      errorSummary: "preflight failed",
    });
    const llmExtract = vi.fn().mockResolvedValue({
      candidates: [
        {
          referenceIndex: 1,
          rawCitation: "Fallback ref",
          title: "Fallback ref",
          authors: null,
          year: 2020,
          venue: null,
          doi: null,
          arxivId: null,
          extractionMethod: "llm_repair",
          extractionConfidence: 0.55,
        },
      ],
      rawResponse: "[]",
    });

    const result = await extractReferenceCandidates({
      paperId: "paper-1",
      filePath: "/tmp/paper.pdf",
      fullText: "references text",
      provider: "openai",
      modelId: "gpt-4o-mini",
      deps: { grobidExtract, llmExtract },
    });

    expect(result.method).toBe("llm_repair");
    expect(result.fallbackReason).toContain("preflight failed");
    expect(result.llmRawResponse).toBe("[]");
    expect(result.attempts).toEqual([
      expect.objectContaining({
        method: "grobid_tei",
        status: "failed",
        candidateCount: 0,
        errorSummary: "preflight failed",
      }),
      expect.objectContaining({
        method: "llm_repair",
        status: "succeeded",
        candidateCount: 1,
      }),
    ]);
  });
});
