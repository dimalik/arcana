import { describe, expect, it } from "vitest";

import { pdfCropRendererInternals } from "../pdf-crop-renderer";

describe("computeCropRegionFromLayout", () => {
  it("chooses table content above the caption when the table caption is below", () => {
    const region = pdfCropRendererInternals.computeCropRegionFromLayout(
      {
        pdfPath: "ignored.pdf",
        page: 1,
        captionYRatio: 560 / 800,
        outDir: "/tmp",
        label: "Table 3",
        type: "table",
      },
      {
        width: 600,
        height: 800,
        textBlocks: [
          { x0: 70, y0: 350, x1: 290, y1: 378, text: "Method Score Win" },
          { x0: 70, y0: 382, x1: 290, y1: 410, text: "A 91 72" },
          { x0: 70, y0: 414, x1: 290, y1: 442, text: "B 89 68" },
          { x0: 70, y0: 560, x1: 300, y1: 586, text: "Table 3: Main benchmark results." },
          { x0: 40, y0: 620, x1: 560, y1: 650, text: "We observe similar trends across settings in the following paragraphs." },
        ],
        imageRects: [],
        drawingRects: [],
      },
    );

    expect(region.kind).toBe("text");
    expect(region.bottom).toBeLessThan(560 / 800);
    expect(region.top).toBeLessThan(400 / 800);
  });

  it("chooses table content below the caption when the table caption is above", () => {
    const region = pdfCropRendererInternals.computeCropRegionFromLayout(
      {
        pdfPath: "ignored.pdf",
        page: 1,
        captionYRatio: 210 / 800,
        outDir: "/tmp",
        label: "Table 1",
        type: "table",
      },
      {
        width: 600,
        height: 800,
        textBlocks: [
          { x0: 70, y0: 150, x1: 290, y1: 178, text: "This paragraph introduces the experiment." },
          { x0: 70, y0: 210, x1: 300, y1: 236, text: "Table 1: Evaluation metrics across tasks." },
          { x0: 70, y0: 248, x1: 290, y1: 276, text: "Method Accuracy F1" },
          { x0: 70, y0: 280, x1: 290, y1: 308, text: "A 91.2 88.1" },
          { x0: 70, y0: 312, x1: 290, y1: 340, text: "B 93.5 90.0" },
        ],
        imageRects: [],
        drawingRects: [],
      },
    );

    expect(region.kind).toBe("text");
    expect(region.top).toBeGreaterThan(236 / 800);
    expect(region.bottom).toBeGreaterThan(320 / 800);
  });

  it("keeps figure crops above the caption and anchored to graphics", () => {
    const region = pdfCropRendererInternals.computeCropRegionFromLayout(
      {
        pdfPath: "ignored.pdf",
        page: 1,
        captionYRatio: 600 / 800,
        outDir: "/tmp",
        label: "Figure 1",
        type: "figure",
      },
      {
        width: 600,
        height: 800,
        textBlocks: [
          { x0: 100, y0: 250, x1: 330, y1: 275, text: "x-axis" },
          { x0: 90, y0: 600, x1: 330, y1: 628, text: "Figure 1: Main chart." },
        ],
        imageRects: [{ x0: 120, y0: 280, x1: 320, y1: 520 }],
        drawingRects: [],
      },
    );

    expect(region.kind).toBe("graphics");
    expect(region.bottom).toBeLessThan(600 / 800);
    expect(region.top).toBeLessThan(300 / 800);
  });

  it("prefers an actual caption block over prose mentions of the same label", () => {
    const region = pdfCropRendererInternals.computeCropRegionFromLayout(
      {
        pdfPath: "ignored.pdf",
        page: 1,
        captionYRatio: 650 / 800,
        outDir: "/tmp",
        label: "Figure 12",
        type: "figure",
      },
      {
        width: 600,
        height: 800,
        textBlocks: [
          {
            x0: 60, y0: 500, x1: 540, y1: 532,
            text: "Figure 12 demonstrates the scalability of the approach across CPUs.",
          },
          { x0: 240, y0: 545, x1: 380, y1: 625, text: "Decoding latency (s) Number of CPU cores RetrievalAttention" },
          {
            x0: 180, y0: 650, x1: 430, y1: 680,
            text: "Figure 12: Decoding latency (s) under different CPU cores.",
          },
        ],
        imageRects: [],
        drawingRects: [
          { x0: 232, y0: 537, x1: 379, y1: 643 },
        ],
      },
    );

    expect(region.kind).toBe("graphics");
    expect(region.bottom).toBeLessThanOrEqual(650 / 800);
    expect(region.top).toBeLessThan(560 / 800);
  });

  it("uses the nearest graphics cluster instead of absorbing distant table rules", () => {
    const region = pdfCropRendererInternals.computeCropRegionFromLayout(
      {
        pdfPath: "ignored.pdf",
        page: 1,
        captionYRatio: 650 / 800,
        outDir: "/tmp",
        label: "Figure 12",
        type: "figure",
      },
      {
        width: 600,
        height: 800,
        textBlocks: [
          { x0: 180, y0: 650, x1: 430, y1: 680, text: "Figure 12: Decoding latency (s) under different CPU cores." },
        ],
        imageRects: [],
        drawingRects: [
          { x0: 120, y0: 430, x1: 500, y1: 450 },
          { x0: 232, y0: 537, x1: 379, y1: 643 },
          { x0: 256, y0: 542, x1: 376, y1: 623 },
        ],
      },
    );

    expect(region.kind).toBe("graphics");
    expect(region.top).toBeGreaterThan(500 / 800);
    expect(region.left).toBeGreaterThan(0.25);
  });

  it("does not pull nearby prose paragraphs into figure support text", () => {
    const region = pdfCropRendererInternals.computeCropRegionFromLayout(
      {
        pdfPath: "ignored.pdf",
        page: 1,
        captionYRatio: 650 / 800,
        outDir: "/tmp",
        label: "Figure 12",
        type: "figure",
      },
      {
        width: 600,
        height: 800,
        textBlocks: [
          {
            x0: 100, y0: 500, x1: 520, y1: 532,
            text: "Figure 12 demonstrates the scalability of RetrievalAttention across CPUs in the appendix discussion.",
          },
          { x0: 240, y0: 545, x1: 380, y1: 625, text: "Decoding latency (s) Number of CPU cores RetrievalAttention" },
          { x0: 180, y0: 650, x1: 430, y1: 680, text: "Figure 12: Decoding latency (s) under different CPU cores." },
        ],
        imageRects: [],
        drawingRects: [
          { x0: 232, y0: 537, x1: 379, y1: 643 },
        ],
      },
    );

    expect(region.top).toBeGreaterThanOrEqual(529 / 800);
  });
});

describe("buildFallbackRegion", () => {
  it("prefers cropping above the caption for tables when there is much more room above", () => {
    const region = pdfCropRendererInternals.buildFallbackRegion({
      pdfPath: "ignored.pdf",
      page: 1,
      captionYRatio: 0.8,
      outDir: "/tmp",
      label: "Table 9",
      type: "table",
      neighborAboveYRatio: 0.1,
      neighborBelowYRatio: 0.86,
    });

    expect(region.bottom).toBeLessThan(0.8);
  });
});
