import { describe, expect, it } from "vitest";
import { mergeFigureSources, type MergeableFigure } from "../source-merger";

function makeFigure(overrides: Partial<MergeableFigure>): MergeableFigure {
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

describe("mergeFigureSources", () => {
  it("does not promote uncaptioned PDF-only assets to canonical rows", () => {
    const merged = mergeFigureSources([
      makeFigure({
        figureLabel: "Figure 1",
        captionText: "Overview.",
        captionSource: "html_figcaption",
        sourceMethod: "arxiv_html",
        confidence: "high",
        imagePath: "uploads/figures/paper/html-1.png",
        assetHash: "html-asset",
        pdfPage: 1,
        width: 640,
        height: 480,
      }),
      makeFigure({
        imagePath: "uploads/figures/paper/p4-img1.png",
        assetHash: "pdf-a",
        pdfPage: 4,
        width: 100,
        height: 100,
      }),
      makeFigure({
        imagePath: "uploads/figures/paper/p4-img2.png",
        assetHash: "pdf-b",
        pdfPage: 4,
        width: 120,
        height: 120,
      }),
    ]);

    const primaries = merged.filter((fig) => fig.isPrimaryExtraction);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].figureLabel).toBe("Figure 1");
    expect(merged.filter((fig) => fig.sourceMethod === "pdf_embedded" && !fig.isPrimaryExtraction)).toHaveLength(2);
  });

  it("still promotes labeled PDF fallback rows when they are the only source", () => {
    const merged = mergeFigureSources([
      makeFigure({
        figureLabel: "Figure 7",
        captionText: "A PDF-only figure.",
        captionSource: "pdf_ocr",
        sourceMethod: "pdf_embedded",
        confidence: "medium",
        imagePath: "uploads/figures/paper/p7-img0.png",
        assetHash: "pdf-labeled",
        pdfPage: 7,
        width: 500,
        height: 350,
      }),
    ]);

    const primaries = merged.filter((fig) => fig.isPrimaryExtraction);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].sourceMethod).toBe("pdf_embedded");
    expect(primaries[0].figureLabel).toBe("Figure 7");
  });

  it("suppresses unlabeled GROBID/PDF-only groups even if they carry caption text", () => {
    const merged = mergeFigureSources([
      makeFigure({
        figureLabel: null,
        captionText: "Confusion matrices showing the performance of detectors...",
        captionSource: "grobid_tei",
        sourceMethod: "grobid_tei",
        confidence: "medium",
        pdfPage: 6,
        bbox: "70.62,74.80,455.44,415.70",
        type: "table",
      }),
    ]);

    expect(merged.filter((fig) => fig.isPrimaryExtraction)).toHaveLength(0);
  });

  it("keeps structured figure semantics canonical while grafting PDF fallback preview separately", () => {
    const merged = mergeFigureSources([
      makeFigure({
        figureLabel: "Figure 2",
        captionText: "Structured caption.",
        captionSource: "html_figcaption",
        sourceMethod: "arxiv_html",
        confidence: "high",
        imagePath: null,
        assetHash: null,
        pdfPage: 2,
        type: "figure",
      }),
      makeFigure({
        figureLabel: "Figure 2",
        captionText: "Structured caption.",
        captionSource: "pdf_ocr",
        sourceMethod: "pdf_render_crop",
        confidence: "low",
        imagePath: "uploads/figures/paper/crop-p2-figure_2.png",
        assetHash: "pdf-crop-2",
        pdfPage: 2,
        width: 640,
        height: 400,
        cropOutcome: "success",
      }),
    ]);

    const primary = merged.find((fig) => fig.isPrimaryExtraction);
    expect(primary).toBeTruthy();
    expect(primary?.sourceMethod).toBe("arxiv_html");
    expect(primary?.imageSourceMethod).toBe("pdf_render_crop");
    expect(primary?.imagePath).toBe("uploads/figures/paper/crop-p2-figure_2.png");
    expect(primary?.captionSource).toBe("html_figcaption");
  });

  it("lets GROBID provide semantics while preserving PDF crop preview when no structured source exists", () => {
    const merged = mergeFigureSources([
      makeFigure({
        figureLabel: "Figure 1",
        captionText: "Figure 1: Confusion matrices for ternary classification.",
        captionSource: "grobid_tei",
        sourceMethod: "grobid_tei",
        confidence: "medium",
        pdfPage: 6,
        bbox: "115.30,86.20,465.40,170.90",
        type: "figure",
      }),
      makeFigure({
        figureLabel: "Figure 1",
        captionText: "Figure 1: Confusion matrices showing the performance...",
        captionSource: "pdf_ocr",
        sourceMethod: "pdf_render_crop",
        confidence: "low",
        imagePath: "uploads/figures/paper/crop-p6-figure_1.png",
        assetHash: "pdf-crop-figure-1",
        pdfPage: 6,
        width: 1501,
        height: 724,
        cropOutcome: "success",
      }),
    ]);

    const primary = merged.find((fig) => fig.isPrimaryExtraction);
    expect(primary).toBeTruthy();
    expect(primary?.sourceMethod).toBe("grobid_tei");
    expect(primary?.imageSourceMethod).toBe("pdf_render_crop");
    expect(primary?.imagePath).toBe("uploads/figures/paper/crop-p6-figure_1.png");
    expect(primary?.captionSource).toBe("grobid_tei");
    expect(primary?.pdfPage).toBe(6);
    expect(primary?.bbox).toBe("115.30,86.20,465.40,170.90");
  });
});
