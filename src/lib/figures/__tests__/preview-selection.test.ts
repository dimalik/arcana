import { describe, expect, it } from "vitest";

import { projectionPublicationInternals } from "../projection-publication";

function makePreviewFigure(overrides: Partial<Parameters<typeof projectionPublicationInternals.buildActivationSelectionDrafts>[0][number]> = {}) {
  return {
    id: "proj-1",
    figureIdentityId: "identity-1",
    identityKey: "identity-key-1",
    publishedFigureHandleId: null,
    sourceMethod: "arxiv_html",
    imageSourceMethod: null,
    basePreviewCandidateId: null,
    figureLabel: "Table 1",
    captionText: "Results",
    captionSource: "html_figcaption",
    structuredContent: "<table><tr><td>A</td></tr></table>",
    structuredContentType: "html_table",
    sourceUrl: "https://arxiv.org/html/1234",
    confidence: "high",
    pdfPage: 5,
    bbox: "10,10,50,50",
    type: "table",
    width: null,
    height: null,
    gapReason: "structured_content_no_preview",
    ...overrides,
  };
}

describe("preview selection drafts", () => {
  it("carries forward rendered previews during activation when the structured table is unchanged", () => {
    const drafts = projectionPublicationInternals.buildActivationSelectionDrafts(
      [makePreviewFigure()],
      new Map([
        ["identity-key-1", {
          projectionFigureId: "prev-proj-1",
          identityKey: "identity-key-1",
          selectedPreviewSource: "rendered",
          selectedPreviewSourceMethod: "html_table_render",
          selectedAssetId: "asset-rendered",
          selectedRenderedPreviewId: "rendered-prev-1",
          selectedNativeCandidateId: null,
          type: "table",
          sourceMethod: "arxiv_html",
          structuredContent: "<table><tr><td>A</td></tr></table>",
        }],
      ]),
      new Map(),
    );

    expect(drafts).toEqual([
      {
        projectionFigureId: "proj-1",
        identityKey: "identity-key-1",
        selectedPreviewSource: "rendered",
        selectedPreviewSourceMethod: "html_table_render",
        selectedAssetId: "asset-rendered",
        selectedRenderedPreviewId: "rendered-prev-1",
        selectedNativeCandidateId: null,
      },
    ]);
  });

  it("falls back to the native preview candidate when carry-forward is invalid", () => {
    const drafts = projectionPublicationInternals.buildActivationSelectionDrafts(
      [makePreviewFigure({
        id: "proj-2",
        figureIdentityId: "identity-2",
        identityKey: "identity-key-2",
        basePreviewCandidateId: "cand-native",
        imageSourceMethod: "pmc_jats",
        sourceMethod: "pmc_jats",
        type: "figure",
        structuredContent: null,
        gapReason: null,
      })],
      new Map(),
      new Map([["cand-native", "asset-native"]]),
    );

    expect(drafts).toEqual([
      {
        projectionFigureId: "proj-2",
        identityKey: "identity-key-2",
        selectedPreviewSource: "native",
        selectedPreviewSourceMethod: "pmc_jats",
        selectedAssetId: "asset-native",
        selectedRenderedPreviewId: null,
        selectedNativeCandidateId: "cand-native",
      },
    ]);
  });

  it("carries forward prior native previews when the new projection has no base preview", () => {
    const drafts = projectionPublicationInternals.buildActivationSelectionDrafts(
      [makePreviewFigure({
        id: "proj-3",
        figureIdentityId: "identity-3",
        identityKey: "identity-key-3",
        sourceMethod: "arxiv_html",
        imageSourceMethod: null,
        basePreviewCandidateId: null,
        type: "table",
        structuredContent: "<table><tr><td>B</td></tr></table>",
        gapReason: "structured_content_no_preview",
      })],
      new Map([
        ["identity-key-3", {
          projectionFigureId: "prev-proj-3",
          identityKey: "identity-key-3",
          selectedPreviewSource: "native",
          selectedPreviewSourceMethod: "pdf_render_crop",
          selectedAssetId: "asset-prev-native",
          selectedRenderedPreviewId: null,
          selectedNativeCandidateId: "cand-prev-native",
          type: "table",
          sourceMethod: "pdf_render_crop",
          structuredContent: null,
        }],
      ]),
      new Map(),
    );

    expect(drafts).toEqual([
      {
        projectionFigureId: "proj-3",
        identityKey: "identity-key-3",
        selectedPreviewSource: "native",
        selectedPreviewSourceMethod: "pdf_render_crop",
        selectedAssetId: "asset-prev-native",
        selectedRenderedPreviewId: null,
        selectedNativeCandidateId: "cand-prev-native",
      },
    ]);
  });

  it("applies enrichment replacements and carries forward untouched preview rows", () => {
    const drafts = projectionPublicationInternals.buildEnrichmentSelectionDrafts(
      [
        makePreviewFigure({ id: "proj-a" }),
        makePreviewFigure({ id: "proj-b", figureIdentityId: "identity-b", identityKey: "identity-key-b" }),
      ],
      new Map([
        ["proj-b", {
          projectionFigureId: "proj-b",
          identityKey: "identity-key-b",
          selectedPreviewSource: "native",
          selectedPreviewSourceMethod: "pmc_jats",
          selectedAssetId: "asset-b",
          selectedRenderedPreviewId: null,
          selectedNativeCandidateId: "cand-b",
        }],
      ]),
      new Map([
        ["proj-a", {
          projectionFigureId: "proj-a",
          assetId: "asset-rendered-a",
          renderedPreviewId: "rendered-a",
          sourceMethod: "html_table_render",
        }],
      ]),
      new Map(),
    );

    expect(drafts).toEqual([
      {
        projectionFigureId: "proj-a",
        identityKey: "identity-key-1",
        selectedPreviewSource: "rendered",
        selectedPreviewSourceMethod: "html_table_render",
        selectedAssetId: "asset-rendered-a",
        selectedRenderedPreviewId: "rendered-a",
        selectedNativeCandidateId: null,
      },
      {
        projectionFigureId: "proj-b",
        identityKey: "identity-key-b",
        selectedPreviewSource: "native",
        selectedPreviewSourceMethod: "pmc_jats",
        selectedAssetId: "asset-b",
        selectedRenderedPreviewId: null,
        selectedNativeCandidateId: "cand-b",
      },
    ]);
  });
});
