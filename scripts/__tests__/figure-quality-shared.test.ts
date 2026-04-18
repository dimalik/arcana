import { describe, expect, it } from "vitest";

import {
  buildPreviewRequiredLabelSet,
  evaluatePreviewRequirement,
} from "../lib/figure-quality-shared";

describe("figure quality shared helpers", () => {
  it("builds preview-required labels from all three fixture sources", () => {
    const labels = buildPreviewRequiredLabelSet({
      requiredParentGroupRows: [{ label: "Figure 1", mustHavePreview: true }],
      labelExpectations: {
        "Table 1": { expectsImage: true },
        "Table 2": { expectsImage: false },
      },
      firstPublishPreviewRequired: true,
      requiredLabels: ["Figure 2", "Table 3"],
    });

    expect(Array.from(labels).sort()).toEqual(["figure_1", "figure_2", "table_1", "table_3"]);
  });

  it("rejects preview-required rows that only have an explicit gap", () => {
    const result = evaluatePreviewRequirement(
      {
        imagePath: null,
        gapReason: "structured_content_no_preview",
      },
      true,
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("real preview");
  });

  it("allows explicit named gaps only for preview-optional rows", () => {
    const result = evaluatePreviewRequirement(
      {
        imagePath: null,
        gapReason: "structured_content_no_preview",
      },
      false,
    );

    expect(result).toEqual({
      passed: true,
      message: "preview-optional row has explicit gapReason=structured_content_no_preview",
    });
  });
});
