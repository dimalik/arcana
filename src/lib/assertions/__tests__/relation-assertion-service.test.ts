import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    relationAssertion: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    relationEvidence: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

import {
  addEvidence,
  createRelationAssertion,
  upsertAssertionWithEvidence,
} from "../relation-assertion-service";

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

describe("upsertAssertionWithEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces prior evidence rows instead of appending", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.relationAssertion.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "assertion-3",
    });
    (prisma.relationEvidence.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 2,
    });
    (prisma.relationEvidence.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
    });

    await upsertAssertionWithEvidence(
      {
        sourceEntityId: "entity-1",
        targetEntityId: "entity-2",
        sourcePaperId: "paper-1",
        relationType: "related",
        confidence: 0.6,
        provenance: "deterministic_relatedness",
      },
      [
        {
          type: "deterministic_signal:direct_citation",
          excerpt: '{"rawValue":1,"weight":0.4,"contribution":0.4}',
          referenceEntryId: "ref-entry-1",
        },
      ],
    );

    expect(prisma.relationEvidence.deleteMany).toHaveBeenCalledWith({
      where: { assertionId: "assertion-3" },
    });
    expect(prisma.relationEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          assertionId: "assertion-3",
          type: "deterministic_signal:direct_citation",
          excerpt: '{"rawValue":1,"weight":0.4,"contribution":0.4}',
          citationMentionId: null,
          referenceEntryId: "ref-entry-1",
        },
      ],
    });
  });

  it("skips createMany when the replacement evidence set is empty", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.relationAssertion.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "assertion-4",
    });
    (prisma.relationEvidence.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
    });

    await upsertAssertionWithEvidence(
      {
        sourceEntityId: "entity-1",
        targetEntityId: "entity-2",
        sourcePaperId: "paper-1",
        relationType: "related",
        confidence: 0.4,
        provenance: "deterministic_relatedness",
      },
      [],
    );

    expect(prisma.relationEvidence.createMany).not.toHaveBeenCalled();
  });
});
