import { describe, expect, it } from "vitest";

import { normalizeSectionLabel } from "./section-normalization";

describe("normalizeSectionLabel", () => {
  it("normalizes introduction variants", () => {
    expect(normalizeSectionLabel("1 Introduction")).toBe("introduction/1");
  });

  it("normalizes method subsections with numbering", () => {
    expect(normalizeSectionLabel("3.1 Experimental Setup")).toBe("method/3.1");
  });

  it("normalizes results-style labels", () => {
    expect(normalizeSectionLabel("4 Experiments")).toBe("results/4");
  });

  it("normalizes appendix labels with letters", () => {
    expect(normalizeSectionLabel("Appendix A Additional Results")).toBe(
      "appendix/A",
    );
  });

  it("falls back to unknown for missing labels", () => {
    expect(normalizeSectionLabel("")).toBe("unknown");
  });
});
