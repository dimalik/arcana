import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../import/url", () => ({
  extractDoiFromUrl: vi.fn(),
  extractUrlContent: vi.fn(),
  fetchDoiMetadata: vi.fn(),
}));

vi.mock("../../import/arxiv", () => ({
  fetchArxivMetadata: vi.fn(),
  searchArxivByTitle: vi.fn(),
}));

vi.mock("../../import/semantic-scholar", () => ({
  searchAllSources: vi.fn(),
}));

vi.mock("../resolver-cache", () => ({
  CACHE_TTL: {
    hit: 1,
    miss: 1,
  },
  withCachedLookup: vi.fn(
    async (
      _lookup: unknown,
      fetcher: () => Promise<{
        responsePayload: string | null;
        resolvedEntityId: string | null;
        httpStatus: number;
      }>,
    ) => fetcher(),
  ),
}));

import {
  isPromotableResolution,
  resolveReferenceOnline,
  scoreResolverCandidate,
} from "../resolve";
import {
  extractDoiFromUrl,
  extractUrlContent,
  fetchDoiMetadata,
} from "../../import/url";
import { fetchArxivMetadata, searchArxivByTitle } from "../../import/arxiv";
import { searchAllSources } from "../../import/semantic-scholar";

describe("reference online resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(extractDoiFromUrl).mockReturnValue(null);
    vi.mocked(extractUrlContent).mockResolvedValue({
      title: "Recovered title",
      content: "",
      excerpt: "",
      siteName: null,
      authors: [],
      year: null,
      doi: null,
      pdfUrl: null,
    });
  });

  it("uses exact DOI metadata before title search", async () => {
    vi.mocked(fetchDoiMetadata).mockResolvedValue({
      title: "BinaryBERT: Pushing the Limit of BERT Quantization",
      abstract: null,
      authors: ["Haoli Bai", "Wei Zhang"],
      year: 2021,
      venue: "ACL",
      doi: "10.18653/v1/2021.acl-long.334",
      openAccessPdfUrl: null,
    });

    const result = await resolveReferenceOnline({
      title: "Noisy title that should not matter",
      doi: "10.18653/v1/2021.acl-long.334",
    });

    expect(result).toEqual(
      expect.objectContaining({
        resolutionMethod: "doi_exact",
        resolutionConfidence: 1,
        matchedIdentifiers: [
          { type: "doi", value: "10.18653/v1/2021.acl-long.334" },
        ],
        candidate: expect.objectContaining({
          title: "BinaryBERT: Pushing the Limit of BERT Quantization",
          doi: "10.18653/v1/2021.acl-long.334",
        }),
      }),
    );
    expect(searchAllSources).not.toHaveBeenCalled();
  });

  it("uses exact arxiv metadata before title search", async () => {
    vi.mocked(fetchArxivMetadata).mockResolvedValue({
      title: "GPT-4 Technical Report",
      abstract: "Abstract",
      authors: ["OpenAI"],
      year: 2023,
      arxivId: "2303.08774",
      categories: ["cs.CL"],
      pdfUrl: "https://arxiv.org/pdf/2303.08774.pdf",
    });

    const result = await resolveReferenceOnline({
      title: "Shyamal Anadkat, et al. Gpt-4 technical report",
      arxivId: "2303.08774",
    });

    expect(result).toEqual(
      expect.objectContaining({
        resolutionMethod: "arxiv_exact",
        resolutionConfidence: 1,
        matchedIdentifiers: [{ type: "arxiv", value: "2303.08774" }],
        candidate: expect.objectContaining({
          title: "GPT-4 Technical Report",
          arxivId: "2303.08774",
        }),
      }),
    );
    expect(searchAllSources).not.toHaveBeenCalled();
  });

  it("infers arxiv ids from raw citations before falling back to title search", async () => {
    vi.mocked(fetchArxivMetadata).mockResolvedValue({
      title: "The Llama 3 Herd of Models",
      abstract: "Abstract",
      authors: ["Abhimanyu Dubey"],
      year: 2024,
      arxivId: "2407.21783",
      categories: ["cs.AI"],
      pdfUrl: "https://arxiv.org/pdf/2407.21783.pdf",
    });

    const result = await resolveReferenceOnline({
      title: "The llama 3 herd of models",
      rawCitation:
        "Abhimanyu Dubey et al. 2024. The llama 3 herd of models. arXiv preprint arXiv:2407.21783.",
    });

    expect(result).toEqual(
      expect.objectContaining({
        resolutionMethod: "arxiv_exact",
        matchedIdentifiers: [{ type: "arxiv", value: "2407.21783" }],
      }),
    );
    expect(searchAllSources).not.toHaveBeenCalled();
  });

  it("skips obvious non-scholarly web references", async () => {
    const result = await resolveReferenceOnline({
      title: "Anthropic. https://www.anthropic.com/news/claude-3-family, 2023.",
      rawCitation: "Anthropic. https://www.anthropic.com/news/claude-3-family, 2023.",
      year: 2023,
    });

    expect(result).toBeNull();
    expect(fetchDoiMetadata).not.toHaveBeenCalled();
    expect(fetchArxivMetadata).not.toHaveBeenCalled();
    expect(searchAllSources).not.toHaveBeenCalled();
  });

  it("falls back to arxiv title search for unresolved preprint titles", async () => {
    vi.mocked(fetchDoiMetadata).mockResolvedValue(null);
    vi.mocked(fetchArxivMetadata).mockResolvedValue(null as never);
    vi.mocked(searchAllSources).mockResolvedValue([]);
    vi.mocked(searchArxivByTitle).mockResolvedValue([
      {
        title: "Pythia: A Suite for Analyzing Large Language Models Across Training and Scaling",
        abstract: "Abstract",
        authors: ["Stella Biderman"],
        year: 2023,
        arxivId: "2304.01373",
        categories: ["cs.CL"],
        pdfUrl: "https://arxiv.org/pdf/2304.01373.pdf",
      },
    ]);

    const result = await resolveReferenceOnline({
      title: "Pythia: A suite for analyzing large language models across training and scaling",
      authors: ["Stella Biderman"],
      year: 2023,
    });

    expect(result).toEqual(
      expect.objectContaining({
        resolutionMethod: "arxiv_candidate",
        matchedIdentifiers: [{ type: "arxiv", value: "2304.01373" }],
        candidate: expect.objectContaining({
          arxivId: "2304.01373",
          source: "arxiv",
        }),
      }),
    );
  });

  it("uses scholarly URL metadata to recover a clean title before candidate search", async () => {
    vi.mocked(fetchDoiMetadata).mockResolvedValue(null);
    vi.mocked(fetchArxivMetadata).mockResolvedValue(null as never);
    vi.mocked(searchAllSources).mockResolvedValue([]);
    vi.mocked(extractUrlContent).mockResolvedValue({
      title: "Language Models are Few-Shot Learners",
      content: "",
      excerpt: "",
      siteName: "Advances in Neural Information Processing Systems",
      authors: ["Brown, Tom", "Mann, Benjamin"],
      year: 2020,
      doi: null,
      pdfUrl: null,
    });
    vi.mocked(searchArxivByTitle).mockResolvedValue([
      {
        title: "Language Models are Few-Shot Learners",
        abstract: "Abstract",
        authors: ["Tom B. Brown"],
        year: 2020,
        arxivId: "2005.14165",
        categories: ["cs.CL"],
        pdfUrl: "https://arxiv.org/pdf/2005.14165.pdf",
      },
    ]);

    const result = await resolveReferenceOnline({
      title: "1457c0d6bfcb4967418bfb8ac142f64a-Abstract",
      rawCitation:
        "Curran Associates, Inc., 2020. URL https: //proceedings.neurips.cc/paper/2020/hash/ 1457c0d6bfcb4967418bfb8ac142f64a-Abstract. html.",
      year: 2020,
      venue: "html",
    });

    expect(extractUrlContent).toHaveBeenCalledWith(
      "https://proceedings.neurips.cc/paper/2020/hash/1457c0d6bfcb4967418bfb8ac142f64a-Abstract.html",
    );
    expect(result).toEqual(
      expect.objectContaining({
        resolutionMethod: "arxiv_candidate",
        matchedIdentifiers: [{ type: "arxiv", value: "2005.14165" }],
        candidate: expect.objectContaining({
          title: "Language Models are Few-Shot Learners",
          source: "arxiv",
        }),
      }),
    );
  });
});

describe("reference resolver scoring", () => {
  it("scores strong title, author, and year matches highly", () => {
    const score = scoreResolverCandidate(
      {
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
        venue: "Advances in Neural Information Processing Systems",
        doi: null,
        arxivId: null,
      },
      {
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
        venue: "Neural Information Processing Systems",
        doi: "10.5555/3295222.3295349",
        arxivId: null,
        semanticScholarId: "https://openalex.org/W123",
      },
    );

    expect(score.hardReject).toBe(false);
    expect(score.confidence).toBeGreaterThanOrEqual(0.9);
    expect(score.matchedFieldCount).toBeGreaterThanOrEqual(3);
    expect(score.matchedIdentifiers).toEqual(
      expect.arrayContaining([
        { type: "doi", value: "10.5555/3295222.3295349" },
        { type: "openalex", value: "https://openalex.org/W123" },
      ]),
    );
  });

  it("matches comma-formatted author surnames from URL metadata correctly", () => {
    const score = scoreResolverCandidate(
      {
        title: "Language Models are Few-Shot Learners",
        authors: ["Brown, Tom", "Mann, Benjamin"],
        year: 2020,
        venue: "Advances in Neural Information Processing Systems",
      },
      {
        title: "Language Models are Few-Shot Learners",
        authors: ["Tom B. Brown", "Benjamin Mann"],
        year: 2020,
        venue: "arXiv (Cornell University)",
        doi: null,
        arxivId: "2005.14165",
        semanticScholarId: "https://openalex.org/W3030163527",
      },
    );

    expect(score.hardReject).toBe(false);
    expect(score.evidence).toEqual(expect.arrayContaining(["author:first", "year:2020"]));
    expect(score.matchedFieldCount).toBeGreaterThanOrEqual(3);
  });

  it("hard-rejects candidates with conflicting exact identifiers", () => {
    const score = scoreResolverCandidate(
      {
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani"],
        year: 2017,
        doi: "10.5555/3295222.3295349",
        arxivId: null,
      },
      {
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani"],
        year: 2017,
        venue: "NeurIPS",
        doi: "10.9999/not-the-same",
        arxivId: null,
        semanticScholarId: "crossref:10.9999/not-the-same",
      },
    );

    expect(score.hardReject).toBe(true);
    expect(score.confidence).toBe(0);
  });
});

describe("promotion gating", () => {
  it("allows exact resolutions to promote edges", () => {
    expect(
      isPromotableResolution({
        resolveSource: "doi_exact",
        resolveConfidence: 1,
        matchedFieldCount: 1,
      }),
    ).toBe(true);
  });

  it("requires high confidence and at least two matching fields for candidate resolutions", () => {
    expect(
      isPromotableResolution({
        resolveSource: "openalex_candidate",
        resolveConfidence: 0.91,
        matchedFieldCount: 2,
      }),
    ).toBe(true);

    expect(
      isPromotableResolution({
        resolveSource: "openalex_candidate",
        resolveConfidence: 0.88,
        matchedFieldCount: 3,
      }),
    ).toBe(false);

    expect(
      isPromotableResolution({
        resolveSource: "crossref_candidate",
        resolveConfidence: 0.95,
        matchedFieldCount: 1,
      }),
    ).toBe(false);
  });
});
