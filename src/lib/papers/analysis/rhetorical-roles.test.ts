import { describe, expect, it } from "vitest";

import { classifyRhetoricalRole } from "./rhetorical-roles";

describe("classifyRhetoricalRole", () => {
  it("classifies contribution claims from claim text", () => {
    expect(
      classifyRhetoricalRole({
        claimText: "Our main contribution is a lightweight retrieval pipeline.",
        sectionLabel: "Conclusion",
      }),
    ).toBe("contribution");
  });

  it("prefers section-driven limitation classification", () => {
    expect(
      classifyRhetoricalRole({
        claimText: "The method fails under domain shift.",
        sectionLabel: "Limitations",
      }),
    ).toBe("limitation");
  });

  it("detects future work from conclusion language", () => {
    expect(
      classifyRhetoricalRole({
        claimText: "Future work will extend the model to multimodal inputs.",
        sectionLabel: "Conclusion",
      }),
    ).toBe("future_work");
  });

  it("classifies results from evaluation language", () => {
    expect(
      classifyRhetoricalRole({
        claimText: "Our model improves BLEU by 2 points over the baseline.",
        sectionLabel: "Experiments",
      }),
    ).toBe("result");
  });

  it("classifies dataset statements from claim text", () => {
    expect(
      classifyRhetoricalRole({
        claimText: "We evaluate on ImageNet and CIFAR-10 benchmarks.",
      }),
    ).toBe("dataset");
  });
});
