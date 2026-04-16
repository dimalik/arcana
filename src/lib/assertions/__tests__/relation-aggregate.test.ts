import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    relationAssertion: {
      findMany: vi.fn(),
    },
  },
}));

import { getAggregatedRelationsForPaper } from "../relation-aggregate";

describe("getAggregatedRelationsForPaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("groups outbound assertions", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.relationAssertion.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "a1",
        sourceEntityId: "e1",
        targetEntityId: "e2",
        relationType: "cites",
        confidence: 0.9,
        provenance: "reference_match",
        description: null,
        targetEntity: { id: "e2", title: "Paper B", year: 2023, authors: null },
        sourceEntity: { id: "e1", title: "Paper A", year: 2024, authors: null },
      },
      {
        id: "a2",
        sourceEntityId: "e1",
        targetEntityId: "e2",
        relationType: "extends",
        confidence: 0.7,
        provenance: "llm_semantic",
        description: "Extends it",
        targetEntity: { id: "e2", title: "Paper B", year: 2023, authors: null },
        sourceEntity: { id: "e1", title: "Paper A", year: 2024, authors: null },
      },
    ]);

    const result = await getAggregatedRelationsForPaper("paper-1", "e1", "user-1");
    expect(result).toHaveLength(2);
  });
});
