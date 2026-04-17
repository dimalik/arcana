import { describe, expect, it } from "vitest";

import {
  mapPaperFigureToView,
  mapPaperFiguresToView,
} from "../read-model";

describe("figure read-model", () => {
  it("maps the published figure contract explicitly", () => {
    const createdAt = new Date("2026-04-17T18:40:00.000Z");

    const view = mapPaperFigureToView({
      id: "fig-1",
      paperId: "paper-1",
      publishedFigureHandleId: "handle-1",
      figureLabel: "Figure 1",
      captionText: "Main result",
      captionSource: "html_figcaption",
      description: "<table><tr><td>1</td></tr></table>",
      sourceMethod: "arxiv_html",
      sourceUrl: "https://arxiv.org/html/1234.5678",
      sourceVersion: "preview-selection-v1",
      confidence: "high",
      imagePath: "/tmp/figure-1.png",
      assetHash: "asset-1",
      pdfPage: 4,
      sourcePage: null,
      figureIndex: 0,
      bbox: "10,20,30,40",
      type: "table",
      parentFigureId: null,
      isPrimaryExtraction: true,
      width: 640,
      height: 480,
      gapReason: null,
      imageSourceMethod: "arxiv_html",
      createdAt,
    });

    expect(view).toEqual({
      id: "fig-1",
      paperId: "paper-1",
      publishedFigureHandleId: "handle-1",
      figureLabel: "Figure 1",
      captionText: "Main result",
      captionSource: "html_figcaption",
      description: "<table><tr><td>1</td></tr></table>",
      sourceMethod: "arxiv_html",
      sourceUrl: "https://arxiv.org/html/1234.5678",
      sourceVersion: "preview-selection-v1",
      confidence: "high",
      imagePath: "/tmp/figure-1.png",
      assetHash: "asset-1",
      pdfPage: 4,
      sourcePage: null,
      figureIndex: 0,
      bbox: "10,20,30,40",
      type: "table",
      parentFigureId: null,
      isPrimaryExtraction: true,
      width: 640,
      height: 480,
      gapReason: null,
      imageSourceMethod: "arxiv_html",
      createdAt,
    });
  });

  it("maps arrays without dropping alternate rows or gap metadata", () => {
    const rows = mapPaperFiguresToView([
      {
        id: "fig-primary",
        paperId: "paper-1",
        publishedFigureHandleId: "handle-1",
        figureLabel: "Table 2",
        captionText: "Structured content",
        captionSource: "publisher_html",
        description: "<table><tr><td>A</td></tr></table>",
        sourceMethod: "publisher_html",
        sourceUrl: null,
        sourceVersion: "preview-selection-v1",
        confidence: "high",
        imagePath: null,
        assetHash: null,
        pdfPage: 7,
        sourcePage: null,
        figureIndex: 1,
        bbox: null,
        type: "table",
        parentFigureId: null,
        isPrimaryExtraction: true,
        width: null,
        height: null,
        gapReason: "structured_content_no_preview",
        imageSourceMethod: null,
        createdAt: new Date("2026-04-17T18:41:00.000Z"),
      },
      {
        id: "fig-alt",
        paperId: "paper-1",
        publishedFigureHandleId: null,
        figureLabel: "Table 2",
        captionText: "Structured content",
        captionSource: "pdf_caption",
        description: null,
        sourceMethod: "pdf_render_crop",
        sourceUrl: null,
        sourceVersion: null,
        confidence: "medium",
        imagePath: "/tmp/table-2.png",
        assetHash: "asset-alt",
        pdfPage: 7,
        sourcePage: null,
        figureIndex: 1,
        bbox: "1,2,3,4",
        type: "table",
        parentFigureId: null,
        isPrimaryExtraction: false,
        width: 1200,
        height: 800,
        gapReason: null,
        imageSourceMethod: "pdf_render_crop",
        createdAt: new Date("2026-04-17T18:41:05.000Z"),
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "fig-primary",
      isPrimaryExtraction: true,
      gapReason: "structured_content_no_preview",
      imageSourceMethod: null,
    });
    expect(rows[1]).toMatchObject({
      id: "fig-alt",
      isPrimaryExtraction: false,
      imagePath: "/tmp/table-2.png",
      imageSourceMethod: "pdf_render_crop",
    });
  });
});
