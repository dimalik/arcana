import { describe, expect, it } from "vitest";

import { matchClaims } from "../../../../scripts/benchmark/claim-matcher";

describe("claim matcher", () => {
  it("aligns the closest claims under the configured threshold", () => {
    const result = matchClaims(
      [
        {
          id: "left-1",
          text: "transformers improve BLEU on WMT14",
          rhetoricalRole: "result",
          facet: "evaluation",
          polarity: "positive",
          sourceSpan: { charStart: 10, charEnd: 40 },
        },
      ],
      [
        {
          id: "right-1",
          text: "the transformer improves bleu on wmt14",
          rhetoricalRole: "result",
          facet: "evaluation",
          polarity: "positive",
          sourceSpan: { charStart: 12, charEnd: 41 },
        },
      ],
    );

    expect(result.matcherVersion).toBe("1.0.0");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.leftId).toBe("left-1");
    expect(result.matches[0]?.rightId).toBe("right-1");
  });
});
