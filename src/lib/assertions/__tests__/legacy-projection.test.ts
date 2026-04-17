import { vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    relationAssertion: { findMany: vi.fn() },
    paperRelation: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { beforeEach, describe, expect, it } from "vitest";
import { pickWinningAssertion, projectLegacyRelation } from "../legacy-projection";

describe("pickWinningAssertion", () => {
  it("prefers user_manual over llm_semantic", () => {
    const winner = pickWinningAssertion([
      { id: "a1", relationType: "cites", confidence: 0.9, provenance: "reference_match", description: null },
      { id: "a2", relationType: "extends", confidence: 0.7, provenance: "user_manual", description: "User" },
    ]);

    expect(winner?.id).toBe("a2");
  });
});

describe("projectLegacyRelation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the projected legacy row when no assertions remain", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.relationAssertion.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.paperRelation.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "rel-1",
    });

    await projectLegacyRelation("paper-1", "paper-2", "entity-1", "entity-2", true);

    expect(prisma.paperRelation.delete).toHaveBeenCalledWith({
      where: { id: "rel-1" },
    });
  });
});
