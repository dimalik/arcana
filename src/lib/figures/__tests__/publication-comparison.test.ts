import { describe, expect, it } from "vitest";

import {
  comparePreviewSelections,
  compareProjectionRuns,
  publicationComparisonInternals,
} from "../publication-comparison";

describe("publication-comparison", () => {
  it("treats duplicate collapse without label loss as safe semantic replacement", () => {
    const result = compareProjectionRuns(
      [
        { figureLabel: "Figure 1" },
        { figureLabel: "Figure 1" },
      ],
      [{ figureLabel: "Figure 1" }],
    );

    expect(result.comparisonStatus).toBe("safe_to_replace");
    expect(JSON.parse(result.comparisonSummary)).toMatchObject({
      changeClasses: ["duplicate_collapse"],
    });
  });

  it("blocks semantic publication when labels are lost", () => {
    const result = compareProjectionRuns(
      [
        { figureLabel: "Figure 1", type: "figure" },
        { figureLabel: "Figure 2", type: "figure" },
      ],
      [{ figureLabel: "Figure 1", type: "figure" }],
    );

    expect(result.comparisonStatus).toBe("regression_blocked");
    expect(JSON.parse(result.comparisonSummary)).toMatchObject({
      missingLabels: ["figure_2"],
    });
  });

  it("blocks preview publication when preview quality regresses", () => {
    const result = comparePreviewSelections(
      [{ identityKey: "id-1", selectedPreviewSource: "rendered" }],
      [{ identityKey: "id-1", selectedPreviewSource: "native" }],
    );

    expect(result.comparisonStatus).toBe("regression_blocked");
    expect(JSON.parse(result.comparisonSummary)).toMatchObject({
      degradedIdentityKeys: ["id-1"],
    });
  });

  it("ranks rendered above native above none", () => {
    expect(publicationComparisonInternals.previewSourceRank("none")).toBe(0);
    expect(publicationComparisonInternals.previewSourceRank("native")).toBe(1);
    expect(publicationComparisonInternals.previewSourceRank("rendered")).toBe(2);
  });

  it("treats bare numeric GROBID labels as duplicate-collapse equivalents when type matches", () => {
    const result = compareProjectionRuns(
      [
        { figureLabel: "1", type: "table" },
        { figureLabel: "Table 1", type: "table" },
        { figureLabel: "2", type: "table" },
        { figureLabel: "Table 2", type: "table" },
      ],
      [
        { figureLabel: "Table 1", type: "table" },
        { figureLabel: "Table 2", type: "table" },
      ],
    );

    expect(result.comparisonStatus).toBe("safe_to_replace");
    expect(JSON.parse(result.comparisonSummary)).toMatchObject({
      changeClasses: ["duplicate_collapse"],
      missingLabels: [],
    });
  });
});
