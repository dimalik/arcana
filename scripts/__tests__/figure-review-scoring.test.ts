import { describe, expect, it } from "vitest";

import {
  evaluateReviewPaper,
  type DatasetPaper,
  type LoadedPaperState,
} from "../lib/figure-review-scoring";

const datasetPaper = (overrides: Partial<DatasetPaper["targets"]> = {}): DatasetPaper => ({
  paperId: "paper-1",
  title: "Grouped Parent Test",
  bucket: "grouped_parent_figures",
  priority: "critical",
  reviewFocus: "Preserve grouped parent rows with previews.",
  targetsStatus: "confirmed",
  targets: {
    requiredLabels: ["Figure 1"],
    ...overrides,
  },
});

const loadedState = (
  overrides: Partial<LoadedPaperState> = {},
): LoadedPaperState => ({
  paperId: "paper-1",
  title: "Grouped Parent Test",
  arxivId: "2402.08265",
  rolloutStatus: "published_extraction",
  primaryFigures: [
    {
      figureLabel: "Figure 1",
      type: "figure",
      sourceMethod: "arxiv_html",
      imageSourceMethod: "html_img",
      imagePath: "/tmp/figure-1.png",
      gapReason: null,
    },
  ],
  figuresWithImages: 1,
  gapFigures: 0,
  ...overrides,
});

describe("figure review dataset scoring", () => {
  it("passes when a required parent/group row survives with a preview", () => {
    const result = evaluateReviewPaper(
      datasetPaper({
        requiredParentGroupRows: [{ label: "Figure 1", mustHavePreview: true }],
      }),
      loadedState(),
    );

    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails when a required parent/group row lacks a preview", () => {
    const result = evaluateReviewPaper(
      datasetPaper({
        requiredParentGroupRows: [{ label: "Figure 1", mustHavePreview: true }],
      }),
      loadedState({
        primaryFigures: [
          {
            figureLabel: "Figure 1",
            type: "figure",
            sourceMethod: "arxiv_html",
            imageSourceMethod: null,
            imagePath: null,
            gapReason: "structured_content_no_preview",
          },
        ],
        figuresWithImages: 0,
        gapFigures: 1,
      }),
    );

    expect(result.checks.filter((check) => !check.passed).map((check) => check.message)).toContain(
      "Figure 1: expected parent/group row preview present with gapReason=null",
    );
  });
});
