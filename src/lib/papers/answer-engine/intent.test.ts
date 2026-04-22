import { describe, expect, it } from "vitest";

import { classifyPaperAnswerIntent } from "./intent";

describe("classifyPaperAnswerIntent", () => {
  it("routes contradiction questions to contradiction analysis", () => {
    expect(
      classifyPaperAnswerIntent({
        question: "Which papers contradict this result?",
      }),
    ).toBe("contradictions");
  });

  it("routes timeline questions to timeline analysis", () => {
    expect(
      classifyPaperAnswerIntent({
        question: "Give me the timeline of how this idea evolved",
      }),
    ).toBe("timeline");
  });

  it("routes compare questions with extra papers to methodology comparison", () => {
    expect(
      classifyPaperAnswerIntent({
        question: "Compare the methodology against the other paper",
        additionalPaperCount: 2,
      }),
    ).toBe("compare_methodologies");
  });

  it("routes requested output formats to generated artifacts", () => {
    expect(
      classifyPaperAnswerIntent({
        question: "Write it as LaTeX",
      }),
    ).toBe("generated_artifact");
  });

  it("routes exact value questions to results", () => {
    expect(
      classifyPaperAnswerIntent({
        question: "What is the Jailbreak DR-1 value for Phi-3-mini?",
      }),
    ).toBe("results");
  });

  it("routes row-level table questions to results-aware handling", () => {
    expect(
      classifyPaperAnswerIntent({
        question: "Show me the Ungroundedness row.",
      }),
    ).toBe("results");
  });

  it("falls back to direct qa for ordinary paper questions", () => {
    expect(
      classifyPaperAnswerIntent({
        question: "What does the main experiment show?",
      }),
    ).toBe("direct_qa");
  });
});
