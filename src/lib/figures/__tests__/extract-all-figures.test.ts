import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paper: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../pdf-figure-pipeline", () => ({
  extractFiguresFromPdf: vi.fn(),
}));

vi.mock("../grobid-tei-extractor", () => ({
  extractFiguresWithGrobid: vi.fn(),
  isGrobidConfigured: vi.fn(() => false),
}));

vi.mock("../pmc-jats-extractor", () => ({
  downloadPmcFigures: vi.fn(),
}));

vi.mock("@/lib/import/figure-downloader", () => ({
  downloadFiguresFromHtml: vi.fn(),
}));

vi.mock("../publisher-parsers", () => ({
  extractWithPublisherParser: vi.fn(),
}));

vi.mock("../extraction-foundation", () => ({
  persistExtractionEvidence: vi.fn(),
}));

vi.mock("../capability-substrate", () => ({
  prepareCapabilitySnapshotForExtraction: vi.fn(),
}));

vi.mock("../identity-resolution", () => ({
  createIdentityResolutionSnapshot: vi.fn(),
}));

vi.mock("../projection-publication", () => ({
  createProjectionRunSnapshot: vi.fn(),
  publishProjectionRun: vi.fn(),
}));

vi.mock("../publication-guards", () => ({
  acquirePaperWorkLease: vi.fn(),
  FigurePublicationGuardConflictError: class FigurePublicationGuardConflictError extends Error {},
  releasePaperWorkLease: vi.fn(),
}));

vi.mock("../source-merger", () => ({
  mergeFigureSources: vi.fn(() => []),
}));

import { prisma } from "@/lib/prisma";
import { downloadFiguresFromHtml } from "@/lib/import/figure-downloader";
import { collectFigureSourceBatches, extractAllFigures } from "../extract-all-figures";

describe("extractAllFigures contract", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects calls that omit caller context before any DB work", async () => {
    await expect(
      extractAllFigures("paper-1", { maxPages: 20 } as never),
    ).rejects.toThrow("extractAllFigures requires a caller context");

    expect(prisma.paper.findUnique).not.toHaveBeenCalled();
  });

  it("rejects invalid maxPages before any DB work", async () => {
    await expect(
      extractAllFigures("paper-1", { context: "route", maxPages: 0 }),
    ).rejects.toThrow("extractAllFigures maxPages must be an integer between 1 and 100");

    expect(prisma.paper.findUnique).not.toHaveBeenCalled();
  });

  it("carries downloader trust diagnostics into the arxiv source report", async () => {
    vi.mocked(downloadFiguresFromHtml).mockResolvedValue({
      downloaded: 2,
      source: "arxiv_html",
      sourceUrl: "https://arxiv.org/html/2602.05494",
      qualityStatus: "downgraded",
      reasonCode: "anonymous_html_candidates_suppressed",
      rawCandidateCount: 3,
      keptCandidateCount: 2,
      suppressedCandidateCount: 1,
      figures: [
        {
          figureLabel: "Figure 1",
          captionText: "Figure 1: Trusted figure.",
          captionSource: "html_figcaption",
          sourceMethod: "arxiv_html",
          sourceUrl: "https://arxiv.org/html/2602.05494#F1",
          confidence: "high",
          imagePath: "uploads/figures/paper-1/html-0.png",
          assetHash: "hash-1",
          type: "figure",
        },
        {
          figureLabel: "Table 1",
          captionText: "Table 1: Trusted table.",
          captionSource: "html_figcaption",
          sourceMethod: "arxiv_html",
          sourceUrl: "https://arxiv.org/html/2602.05494#T1",
          confidence: "high",
          imagePath: null,
          assetHash: null,
          type: "table",
          tableHtml: "<table><tr><td>A</td></tr></table>",
        },
      ],
    });

    const result = await collectFigureSourceBatches(
      {
        id: "paper-1",
        title: "Broken HTML",
        filePath: null,
        doi: null,
        arxivId: "2602.05494",
        sourceUrl: null,
      },
      {
        capabilitySnapshotId: "snapshot-1",
        coverageClass: "arxiv_usable",
        entries: [
          {
            source: "pmc_jats",
            status: "unusable",
            reasonCode: "missing_doi",
            sourceCapabilityEvaluationId: "cap-1",
          },
          {
            source: "arxiv_html",
            status: "usable",
            reasonCode: "arxiv_id_present",
            sourceCapabilityEvaluationId: "cap-2",
          },
          {
            source: "publisher_html",
            status: "unusable",
            reasonCode: "missing_doi",
            sourceCapabilityEvaluationId: "cap-3",
          },
        ],
      },
      { skipPdf: true, maxPages: 20 },
    );

    expect(result.sourceReport.find((entry) => entry.method === "arxiv_html")).toMatchObject({
      method: "arxiv_html",
      attempted: true,
      figuresFound: 2,
      qualityStatus: "downgraded",
      reasonCode: "anonymous_html_candidates_suppressed",
      rawCandidateCount: 3,
      keptCandidateCount: 2,
      suppressedCandidateCount: 1,
    });
  });
});
