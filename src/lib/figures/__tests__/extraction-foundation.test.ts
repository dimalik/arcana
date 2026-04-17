import { describe, expect, it } from "vitest";

import {
  extractionFoundationInternals,
  type ExtractionSourceBatch,
} from "../extraction-foundation";
import type { MergeableFigure } from "../source-merger";

function makeFigure(overrides: Partial<MergeableFigure> = {}): MergeableFigure {
  return {
    figureLabel: null,
    captionText: null,
    captionSource: "none",
    sourceMethod: "pdf_embedded",
    sourceUrl: null,
    confidence: "low",
    imagePath: null,
    assetHash: null,
    pdfPage: null,
    bbox: null,
    type: "figure",
    width: null,
    height: null,
    description: null,
    cropOutcome: null,
    gapReason: null,
    imageSourceMethod: null,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<ExtractionSourceBatch> = {}): ExtractionSourceBatch {
  return {
    method: "pmc_jats",
    attempted: true,
    figures: [],
    ...overrides,
  };
}

describe("extraction foundation helpers", () => {
  it("classifies source-attempt states conservatively", () => {
    expect(extractionFoundationInternals.classifyAttemptStatus(makeBatch({ attempted: false }))).toBe("skipped");
    expect(extractionFoundationInternals.classifyAttemptStatus(makeBatch({ error: "boom" }))).toBe("failed");
    expect(extractionFoundationInternals.classifyAttemptStatus(makeBatch({
      error: "partial",
      figures: [makeFigure()],
    }))).toBe("partial");
    expect(extractionFoundationInternals.classifyAttemptStatus(makeBatch())).toBe("succeeded");
  });

  it("prefers stable asset locators when present", () => {
    const locator = extractionFoundationInternals.buildSourceLocalLocator(
      makeFigure({
        sourceMethod: "arxiv_html",
        figureLabel: "Figure 2",
        assetHash: "abc123",
      }),
      4,
    );

    expect(locator).toBe("arxiv_html:asset:abc123");
  });

  it("marks PDF crops as untrusted preview evidence", () => {
    expect(extractionFoundationInternals.inferNativePreviewTrust(makeFigure({
      sourceMethod: "pdf_render_crop",
      imagePath: "uploads/figures/paper/crop.png",
    }))).toBe("untrusted_native");

    expect(extractionFoundationInternals.inferNativePreviewTrust(makeFigure({
      sourceMethod: "grobid_tei",
      imagePath: "uploads/figures/paper/grobid-preview.png",
    }))).toBe("untrusted_native");

    expect(extractionFoundationInternals.inferNativePreviewTrust(makeFigure({
      sourceMethod: "pmc_jats",
      imagePath: "uploads/figures/paper/fig1.png",
    }))).toBe("trusted_native");
  });

  it("encodes page-anchor evidence as JSON only when available", () => {
    expect(extractionFoundationInternals.buildPageAnchorCandidate(makeFigure())).toBeNull();
    expect(extractionFoundationInternals.buildPageAnchorCandidate(makeFigure({
      pdfPage: 9,
      bbox: "10,20,30,40",
    }))).toBe(JSON.stringify({ pdfPage: 9, bbox: "10,20,30,40" }));
  });

  it("detects structured-content type from the payload", () => {
    expect(extractionFoundationInternals.inferStructuredContentType(makeFigure({
      type: "table",
      description: "<table><tr><td>x</td></tr></table>",
    }))).toBe("html_table");

    expect(extractionFoundationInternals.inferStructuredContentType(makeFigure({
      type: "table",
      description: "\\begin{ltx_tabular} ...",
    }))).toBe("latex_table");
  });
});
