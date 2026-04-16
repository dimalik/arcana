import { vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    relationAssertion: { findMany: vi.fn() },
    paperRelation: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { describe, expect, it } from "vitest";
import { pickWinningAssertion } from "../legacy-projection";

describe("pickWinningAssertion", () => {
  it("prefers user_manual over llm_semantic", () => {
    const winner = pickWinningAssertion([
      { id: "a1", relationType: "cites", confidence: 0.9, provenance: "reference_match", description: null },
      { id: "a2", relationType: "extends", confidence: 0.7, provenance: "user_manual", description: "User" },
    ]);

    expect(winner?.id).toBe("a2");
  });
});
