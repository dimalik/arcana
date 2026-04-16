import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    paperEntity: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    paperIdentifier: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    paperEntityCandidateLink: {
      create: vi.fn(),
    },
  },
}));

import { resolveOrCreateEntity } from "../entity-service";

describe("resolveOrCreateEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing entity when DOI matches", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.paperIdentifier.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      entityId: "entity-1",
      entity: { id: "entity-1", title: "Existing Paper", mergedIntoEntityId: null },
    });
    (prisma.paperEntity.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "entity-1",
      mergedIntoEntityId: null,
    });

    const result = await resolveOrCreateEntity({
      title: "Existing Paper",
      identifiers: [{ type: "doi", value: "10.1234/abc", source: "import" }],
      source: "import",
    });

    expect(result).toEqual({ entityId: "entity-1", created: false });
  });

  it("creates a new entity when no identifier matches", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.paperIdentifier.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.paperEntity.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "entity-new" });
    (prisma.paperIdentifier.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await resolveOrCreateEntity({
      title: "New Paper",
      authors: '["Alice"]',
      year: 2024,
      identifiers: [{ type: "doi", value: "10.9999/new", source: "import" }],
      source: "import",
    });

    expect(result).toEqual({ entityId: "entity-new", created: true });
    expect(prisma.paperEntity.create).toHaveBeenCalled();
  });

  it("registers missing identifiers on an existing entity", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.paperIdentifier.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        entityId: "entity-1",
        entity: { id: "entity-1", title: "Paper", mergedIntoEntityId: null },
      })
      .mockResolvedValueOnce(null);
    (prisma.paperEntity.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "entity-1",
      mergedIntoEntityId: null,
    });
    (prisma.paperIdentifier.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await resolveOrCreateEntity({
      title: "Paper",
      identifiers: [
        { type: "doi", value: "10.1234/abc", source: "import" },
        { type: "arxiv", value: "2301.12345", source: "import" },
      ],
      source: "import",
    });

    expect(prisma.paperIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: "entity-1",
        type: "arxiv",
        value: "2301.12345",
      }),
    });
  });
});
