import { describe, expect, it } from "vitest";

import {
  figureOverrideInternals,
  FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY,
  FIGURE_OVERRIDE_TYPE_FORCE_GAP_REASON,
  FIGURE_OVERRIDE_TYPE_SUPPRESS_PREVIEW,
} from "../figure-overrides";

describe("figure-overrides", () => {
  it("forces a projection draft into a gap state", () => {
    const drafts = [{
      identityKey: "figure:default:label:figure_1",
      imageSourceMethod: "pdf_embedded",
      basePreviewCandidateId: "candidate-1",
      imagePath: "uploads/example.png",
      assetHash: "hash-1",
      width: 640,
      height: 480,
      gapReason: null,
    }];

    const result = figureOverrideInternals.applyProjectionFigureOverrides(drafts, [{
      id: "override-1",
      overrideType: FIGURE_OVERRIDE_TYPE_FORCE_GAP_REASON,
      selectorType: FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY,
      selectorValue: "figure:default:label:figure_1",
      payload: JSON.stringify({ gapReason: "manual_override" }),
    }]);

    expect(result[0]).toMatchObject({
      imageSourceMethod: null,
      basePreviewCandidateId: null,
      imagePath: null,
      assetHash: null,
      width: null,
      height: null,
      gapReason: "manual_override",
    });
  });

  it("suppresses a selected preview for a targeted identity", () => {
    const figures = [{
      projectionFigureId: "projection-1",
      identityKey: "table:default:label:table_1",
    }];
    const drafts = [{
      projectionFigureId: "projection-1",
      selectedPreviewSource: "rendered",
      selectedPreviewSourceMethod: "html_table_render",
      selectedAssetId: "asset-1",
      selectedRenderedPreviewId: "rendered-1",
      selectedNativeCandidateId: null,
    }];

    const result = figureOverrideInternals.applyPreviewSelectionOverrides(figures, drafts, [{
      id: "override-2",
      overrideType: FIGURE_OVERRIDE_TYPE_SUPPRESS_PREVIEW,
      selectorType: FIGURE_OVERRIDE_SELECTOR_IDENTITY_KEY,
      selectorValue: "table:default:label:table_1",
      payload: null,
    }]);

    expect(result[0]).toEqual({
      projectionFigureId: "projection-1",
      selectedPreviewSource: "none",
      selectedPreviewSourceMethod: null,
      selectedAssetId: null,
      selectedRenderedPreviewId: null,
      selectedNativeCandidateId: null,
    });
  });
});
