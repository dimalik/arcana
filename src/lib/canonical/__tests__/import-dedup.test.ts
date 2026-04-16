import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    paper: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../entity-service", () => ({
  collectIdentifiers: vi.fn(),
  resolveOrCreateEntity: vi.fn(),
}));

import { handleDuplicatePaperError, resolveEntityForImport } from "../import-dedup";

describe("resolveEntityForImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing paper when entity already exists for user", async () => {
    const { prisma } = await import("../../prisma");
    const { collectIdentifiers, resolveOrCreateEntity } = await import("../entity-service");

    (collectIdentifiers as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "doi", value: "10.1234/abc", source: "import" },
    ]);
    (resolveOrCreateEntity as ReturnType<typeof vi.fn>).mockResolvedValue({
      entityId: "entity-1",
      created: false,
    });
    (prisma.paper.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "paper-1",
      title: "Existing",
      year: 2024,
      authors: '["Alice"]',
    });

    const result = await resolveEntityForImport({
      userId: "user-1",
      title: "Existing",
      doi: "10.1234/abc",
    });

    expect(result.existingPaper?.id).toBe("paper-1");
    expect(result.entityId).toBe("entity-1");
  });

  it("falls back to title matching when there are no identifiers", async () => {
    const { prisma } = await import("../../prisma");
    const { collectIdentifiers } = await import("../entity-service");
    (collectIdentifiers as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (prisma.paper.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "paper-1", title: "Attention Is All You Need", year: 2017, authors: null },
    ]);

    const result = await resolveEntityForImport({
      userId: "user-1",
      title: "Attention Is All You Need",
    });

    expect(result.existingPaper?.id).toBe("paper-1");
    expect(result.entityId).toBeNull();
  });
});

describe("handleDuplicatePaperError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the winning paper on P2002", async () => {
    const { prisma } = await import("../../prisma");
    (prisma.paper.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "paper-1",
      title: "Winner",
      year: 2024,
      authors: null,
    });

    const error = Object.assign(new Error("duplicate"), { code: "P2002" });
    const result = await handleDuplicatePaperError(error, "user-1", "entity-1");
    expect(result?.id).toBe("paper-1");
  });
});
