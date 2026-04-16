import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    relationAssertion: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    relationEvidence: {
      create: vi.fn(),
    },
  },
}));

import { addEvidence, createRelationAssertion } from "../relation-assertion-service";

describe("createRelationAssertion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts when sourcePaperId is present", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.relationAssertion.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "assertion-1" });

    const result = await createRelationAssertion({
      sourceEntityId: "entity-1",
      targetEntityId: "entity-2",
      sourcePaperId: "paper-1",
      relationType: "cites",
      confidence: 0.95,
      provenance: "reference_match",
      extractorVersion: "v1",
    });

    expect(result.id).toBe("assertion-1");
  });

  it("falls back to create when sourcePaperId is absent", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.relationAssertion.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "assertion-2" });

    const result = await createRelationAssertion({
      sourceEntityId: "entity-1",
      targetEntityId: "entity-2",
      relationType: "similar",
      confidence: 0.7,
      provenance: "discovery",
    });

    expect(result.id).toBe("assertion-2");
  });
});

describe("addEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates evidence", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.relationEvidence.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "ev-1" });

    await addEvidence({
      assertionId: "assertion-1",
      type: "citation_mention",
      citationMentionId: "mention-1",
    });

    expect(prisma.relationEvidence.create).toHaveBeenCalled();
  });
});
