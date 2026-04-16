import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    referenceEntry: {
      create: vi.fn(),
      update: vi.fn(),
    },
    paperIdentifier: {
      findUnique: vi.fn(),
    },
  },
}));

import { createReferenceEntry, resolveReferenceEntity } from "../reference-entry-service";

describe("createReferenceEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a reference entry", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.referenceEntry.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "ref-1" });

    const result = await createReferenceEntry({
      paperId: "paper-1",
      title: "Attention Is All You Need",
      rawCitation: "Vaswani et al.",
    });

    expect(result.id).toBe("ref-1");
  });
});

describe("resolveReferenceEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves on DOI match", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.paperIdentifier.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ entityId: "entity-1" });
    (prisma.referenceEntry.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await resolveReferenceEntity("ref-1", {
      doi: "10.1234/abc",
      arxivId: null,
      title: "Paper",
    });

    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "ref-1" },
      data: expect.objectContaining({
        resolvedEntityId: "entity-1",
        resolveSource: "doi_match",
      }),
    });
  });
});
