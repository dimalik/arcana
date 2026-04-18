import { describe, expect, it } from "vitest";

import {
  evaluateAcceptancePaper,
  type AcceptanceFigureRow,
  type FixturePaper,
} from "../lib/figure-acceptance-scoring";

const fixturePaper = (overrides: Partial<FixturePaper> = {}): FixturePaper => ({
  arxivId: "2510.21391",
  title: "Acceptance Test",
  category: "ltx_tabular",
  expectedFigures: ["Figure 1"],
  expectedTables: [],
  ...overrides,
});

const figureRow = (overrides: Partial<AcceptanceFigureRow> = {}): AcceptanceFigureRow => ({
  figureLabel: "Figure 1",
  sourceMethod: "arxiv_html",
  imageSourceMethod: "html_table_render",
  imagePath: "/tmp/figure-1.png",
  gapReason: null,
  confidence: "high",
  description: null,
  ...overrides,
});

describe("figure acceptance scoring", () => {
  it("passes preview-required rows only when a real preview exists", () => {
    const result = evaluateAcceptancePaper({
      fixturePaper: fixturePaper({ firstPublishPreviewRequired: true }),
      figures: [figureRow()],
      gapReasonExists: true,
      enforceFirstPublishPreviewRules: true,
    });

    expect(result.labelViolations).toEqual([]);
  });

  it("fails preview-required rows when they only have an explicit gapReason", () => {
    const result = evaluateAcceptancePaper({
      fixturePaper: fixturePaper({ firstPublishPreviewRequired: true }),
      figures: [
        figureRow({
          imagePath: null,
          gapReason: "structured_content_no_preview",
        }),
      ],
      gapReasonExists: true,
      enforceFirstPublishPreviewRules: true,
    });

    expect(result.labelViolations.some((message) => (
      message.includes("expected preview-required row to have a real preview")
      && message.includes("gapReason=structured_content_no_preview")
    ))).toBe(true);
  });

  it("allows explicit gaps for preview-optional rows", () => {
    const result = evaluateAcceptancePaper({
      fixturePaper: fixturePaper({
        expectedFigures: [],
        expectedTables: ["Table 1"],
      }),
      figures: [
        figureRow({
          figureLabel: "Table 1",
          imagePath: null,
          gapReason: "structured_content_no_preview",
        }),
      ],
      gapReasonExists: true,
      enforceFirstPublishPreviewRules: true,
    });

    expect(result.labelViolations).toEqual([]);
  });

  it("treats required parent/group rows as preview-required even without bucket-wide first-publish rules", () => {
    const result = evaluateAcceptancePaper({
      fixturePaper: fixturePaper({
        expectedFigures: [],
        requiredParentGroupRows: [{ label: "Figure 1", mustHavePreview: true }],
      }),
      figures: [
        figureRow({
          imagePath: null,
          gapReason: "structured_content_no_preview",
        }),
      ],
      gapReasonExists: true,
      enforceFirstPublishPreviewRules: true,
    });

    expect(result.labelViolations.some((message) => (
      message.includes("expected preview-required row to have a real preview")
      && message.includes("gapReason=structured_content_no_preview")
    ))).toBe(true);
  });
});
