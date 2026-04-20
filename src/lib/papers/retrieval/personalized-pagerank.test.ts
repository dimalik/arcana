import { beforeEach, describe, expect, it, vi } from "vitest";

const searchSharedPaperRepresentationsByPaperMock = vi.fn();

vi.mock("./embeddings", () => ({
  searchSharedPaperRepresentationsByPaper: (
    ...args: Parameters<typeof searchSharedPaperRepresentationsByPaperMock>
  ) => searchSharedPaperRepresentationsByPaperMock(...args),
}));

import { generatePersonalizedPageRankRelatedCandidates } from "./personalized-pagerank";

function createDb() {
  return {
    paper: {
      findMany: vi.fn(async () => [
        { id: "seed", title: "Seed Paper" },
        { id: "a", title: "Direct Neighbor" },
        { id: "b", title: "Two-Hop Neighbor" },
        { id: "c", title: "Semantic Bridge Only" },
      ]),
    },
    paperRelation: {
      findMany: vi.fn(async () => [
        { sourcePaperId: "seed", targetPaperId: "a" },
        { sourcePaperId: "a", targetPaperId: "b" },
      ]),
    },
    paperRepresentation: {} as never,
  };
}

function createTypedDb(): Parameters<
  typeof generatePersonalizedPageRankRelatedCandidates
>[1] {
  return createDb() as unknown as Parameters<
    typeof generatePersonalizedPageRankRelatedCandidates
  >[1];
}

describe("personalized-pagerank candidate generation", () => {
  beforeEach(() => {
    searchSharedPaperRepresentationsByPaperMock.mockReset();
  });

  it("keeps seed-local graph neighbors ahead of semantic-only bridges", async () => {
    searchSharedPaperRepresentationsByPaperMock.mockResolvedValue([
      {
        paperId: "c",
        title: "Semantic Bridge Only",
        score: 0.9,
      },
    ]);

    const result = await generatePersonalizedPageRankRelatedCandidates(
      {
        paperId: "seed",
        userId: "user-1",
        limit: 3,
      },
      createTypedDb(),
    );

    expect(result.candidates.map((candidate) => candidate.paperId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.candidates[2]?.signals.semanticBridgeScore).toBe(0.9);
    expect(result.diagnostics.semanticBridgeCount).toBe(1);
  });

  it("drops semantic bridges below the configured score floor", async () => {
    searchSharedPaperRepresentationsByPaperMock.mockResolvedValue([
      {
        paperId: "c",
        title: "Semantic Bridge Only",
        score: 0.12,
      },
    ]);

    const result = await generatePersonalizedPageRankRelatedCandidates(
      {
        paperId: "seed",
        userId: "user-1",
        limit: 3,
        semanticScoreFloor: 0.18,
      },
      createTypedDb(),
    );

    expect(result.candidates.map((candidate) => candidate.paperId)).toEqual([
      "a",
      "b",
    ]);
    expect(result.diagnostics.semanticBridgeCount).toBe(0);
  });
});
