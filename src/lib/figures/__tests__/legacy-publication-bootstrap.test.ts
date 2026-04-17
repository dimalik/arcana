import { describe, expect, it } from "vitest";

import { legacyPublicationBootstrapInternals } from "../legacy-publication-bootstrap";

function makeLegacyFigure(overrides: Partial<Parameters<typeof legacyPublicationBootstrapInternals.legacyFigureToMergeable>[0]> = {}) {
  return {
    id: "paper-figure-1",
    publishedFigureHandleId: null,
    figureLabel: "Figure 1",
    captionText: "Legacy caption",
    captionSource: "html_figcaption",
    description: null,
    sourceMethod: "arxiv_html",
    sourceUrl: "https://arxiv.org/html/1234",
    confidence: "high",
    imagePath: "uploads/figures/paper/fig1.png",
    assetHash: "asset-1",
    pdfPage: 4,
    bbox: "10,20,30,40",
    type: "figure",
    width: 320,
    height: 200,
    gapReason: null,
    imageSourceMethod: "arxiv_html",
    figureIndex: 0,
    isPrimaryExtraction: true,
    ...overrides,
  };
}

describe("legacy publication bootstrap helpers", () => {
  it("drops compatibility-only synthetic labels before creating bootstrap candidates", () => {
    expect(
      legacyPublicationBootstrapInternals.stripCompatibilityFigureLabel("uncaptioned-abcd1234"),
    ).toBeNull();
    expect(
      legacyPublicationBootstrapInternals.stripCompatibilityFigureLabel("Figure 4"),
    ).toBe("Figure 4");
  });

  it("builds stable legacy locators from published handles first", () => {
    const locator = legacyPublicationBootstrapInternals.buildLegacySourceLocalLocator(
      "paper-1",
      makeLegacyFigure({ publishedFigureHandleId: "handle-1" }),
      0,
    );

    expect(locator).toBe("legacy_bootstrap:handle:handle-1");
  });

  it("marks PDF-derived legacy previews as untrusted", () => {
    expect(
      legacyPublicationBootstrapInternals.inferLegacyNativePreviewTrust(
        makeLegacyFigure({
          imageSourceMethod: "pdf_render_crop",
        }),
      ),
    ).toBe("untrusted_native");

    expect(
      legacyPublicationBootstrapInternals.inferLegacyNativePreviewTrust(
        makeLegacyFigure({
          imageSourceMethod: "pmc_jats",
        }),
      ),
    ).toBe("trusted_native");
  });

  it("preserves legacy alternates as mergeable rows with normalized fields", () => {
    const merged = legacyPublicationBootstrapInternals.legacyFigureToMergeable(
      makeLegacyFigure({
        figureLabel: "uncaptioned-deadbeef",
        isPrimaryExtraction: false,
        imageSourceMethod: "pdf_render_crop",
        gapReason: "structured_content_no_preview",
      }),
    );

    expect(merged.figureLabel).toBeNull();
    expect(merged.isPrimaryExtraction).toBe(false);
    expect(merged.imageSourceMethod).toBe("pdf_render_crop");
    expect(merged.gapReason).toBe("structured_content_no_preview");
  });
});

