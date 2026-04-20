import { describe, expect, it } from "vitest";

import {
  RETRIEVAL_DIVERSIFY_DEFAULTS,
  diversifyCandidates,
} from "./diversify";

describe("diversifyCandidates", () => {
  it("boosts unseen subtopics", () => {
    const diversified = diversifyCandidates(
      [
        {
          id: "a",
          relevanceScore: 0.9,
          subtopics: ["transformers"],
          vector: [1, 0, 0],
        },
        {
          id: "b",
          relevanceScore: 0.88,
          subtopics: ["transformers"],
          vector: [0.99, 0.01, 0],
        },
        {
          id: "c",
          relevanceScore: 0.82,
          subtopics: ["retrieval"],
          vector: [0, 1, 0],
        },
      ],
      { task: "related", limit: 2 },
    );

    expect(diversified.map((candidate) => candidate.id)).toEqual(["a", "c"]);
  });

  it("penalizes hub-heavy candidates when relevance is close", () => {
    const diversified = diversifyCandidates(
      [
        {
          id: "hub",
          relevanceScore: 0.86,
          hubScore: 1,
          vector: [1, 0],
        },
        {
          id: "non-hub",
          relevanceScore: 0.84,
          hubScore: 0,
          vector: [0, 1],
        },
      ],
      {
        task: "related",
        limit: 1,
      },
    );

    expect(diversified[0]?.id).toBe("non-hub");
  });

  it("keeps committed per-task lambda defaults stable", () => {
    expect(RETRIEVAL_DIVERSIFY_DEFAULTS.related.lambda).toBe(0.65);
    expect(RETRIEVAL_DIVERSIFY_DEFAULTS.search.lambda).toBe(0.82);
    expect(RETRIEVAL_DIVERSIFY_DEFAULTS.recommendations.lambda).toBe(0.55);
  });
});
