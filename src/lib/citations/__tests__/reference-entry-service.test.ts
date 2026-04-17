import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    referenceEntry: {
      create: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    reference: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    paper: {
      findFirst: vi.fn(),
    },
    paperIdentifier: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../../canonical/entity-service", () => ({
  resolveOrCreateEntity: vi.fn(),
}));

vi.mock("../../references/resolve", () => ({
  resolveReferenceOnline: vi.fn(),
}));

import { prisma } from "../../prisma";
import { resolveOrCreateEntity } from "../../canonical/entity-service";
import { resolveReferenceOnline } from "../../references/resolve";
import {
  createReferenceEntry,
  deleteReferenceEntryWithLegacyProjection,
  enrichReferenceEntryFromCandidate,
  findReferenceEntryForPaper,
  projectReferenceEntryImportLink,
  resolveReferenceEntity,
} from "../reference-entry-service";

describe("createReferenceEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a reference entry", async () => {
    vi.mocked(prisma.referenceEntry.create).mockResolvedValue({ id: "ref-1" } as never);

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
    vi.mocked(prisma.paperIdentifier.findUnique).mockResolvedValue({ entityId: "entity-1" } as never);
    vi.mocked(prisma.referenceEntry.update).mockResolvedValue({} as never);

    const result = await resolveReferenceEntity("ref-1", {
      doi: "10.1234/abc",
      arxivId: null,
      title: "Paper",
    });

    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "ref-1" },
      data: expect.objectContaining({
        resolvedEntityId: "entity-1",
        resolveSource: "doi_exact",
      }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        resolvedEntityId: "entity-1",
        resolveSource: "doi_exact",
        matchedIdentifiers: [{ type: "doi", value: "10.1234/abc" }],
      }),
    );
    expect(resolveReferenceOnline).not.toHaveBeenCalled();
  });

  it("resolves via online candidate search and creates or reuses an entity", async () => {
    vi.mocked(prisma.paperIdentifier.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.referenceEntry.update).mockResolvedValue({} as never);
    vi.mocked(resolveReferenceOnline).mockResolvedValue({
      candidate: {
        semanticScholarId: "https://openalex.org/W123",
        title: "Attention Is All You Need",
        abstract: null,
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
        venue: "NeurIPS",
        doi: "10.5555/3295222.3295349",
        arxivId: null,
        openReviewId: null,
        externalUrl: "https://doi.org/10.5555/3295222.3295349",
        citationCount: 1000,
        openAccessPdfUrl: null,
        source: "openalex",
      },
      resolutionMethod: "openalex_candidate",
      resolutionConfidence: 0.94,
      matchedFieldCount: 3,
      matchedIdentifiers: [{ type: "doi", value: "10.5555/3295222.3295349" }],
      evidence: ["title:1.00", "year:2017", "author:first"],
    });
    vi.mocked(resolveOrCreateEntity).mockResolvedValue({
      entityId: "entity-2",
      created: false,
    });

    const result = await resolveReferenceEntity("ref-1", {
      doi: null,
      arxivId: null,
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani"],
      year: 2017,
      venue: "NeurIPS",
      rawCitation: "Attention Is All You Need",
    });

    expect(resolveReferenceOnline).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Attention Is All You Need",
        year: 2017,
      }),
    );
    expect(resolveOrCreateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Attention Is All You Need",
        identifiers: expect.arrayContaining([
          expect.objectContaining({
            type: "doi",
            value: "10.5555/3295222.3295349",
          }),
          expect.objectContaining({
            type: "openalex",
            value: "https://openalex.org/W123",
          }),
        ]),
        source: "openalex",
      }),
    );
    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "ref-1" },
      data: expect.objectContaining({
        resolvedEntityId: "entity-2",
        resolveConfidence: 0.94,
        resolveSource: "openalex_candidate",
        semanticScholarId: "https://openalex.org/W123",
      }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        resolvedEntityId: "entity-2",
        resolveSource: "openalex_candidate",
        matchedFieldCount: 3,
      }),
    );
  });

  it("returns unresolved when online candidates are too weak or unavailable", async () => {
    vi.mocked(prisma.paperIdentifier.findUnique).mockResolvedValue(null as never);
    vi.mocked(resolveReferenceOnline).mockResolvedValue(null);

    const result = await resolveReferenceEntity("ref-1", {
      doi: null,
      arxivId: null,
      title: "Ambiguous Paper",
    });

    expect(result).toEqual({
      resolvedEntityId: null,
      resolveConfidence: null,
      resolveSource: null,
      matchedFieldCount: 0,
      matchedIdentifiers: [],
      evidence: [],
      semanticScholarId: null,
      externalUrl: null,
    });
    expect(prisma.referenceEntry.update).not.toHaveBeenCalled();
    expect(resolveOrCreateEntity).not.toHaveBeenCalled();
  });
});

describe("deleteReferenceEntryWithLegacyProjection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the reference entry and legacy reference in one transaction", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue({
      id: "entry-1",
      legacyReferenceId: "legacy-1",
    } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: never) =>
      callback({
        reference: {
          deleteMany: prisma.reference.deleteMany,
        },
        referenceEntry: {
          delete: prisma.referenceEntry.delete,
        },
      }),
    );
    vi.mocked(prisma.reference.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.referenceEntry.delete).mockResolvedValue({ id: "entry-1" } as never);

    const result = await deleteReferenceEntryWithLegacyProjection("paper-1", "legacy-1");

    expect(prisma.referenceEntry.findFirst).toHaveBeenCalledWith({
      where: {
        paperId: "paper-1",
        OR: [{ id: "legacy-1" }, { legacyReferenceId: "legacy-1" }],
      },
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });
    expect(prisma.reference.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "legacy-1",
        paperId: "paper-1",
      },
    });
    expect(prisma.referenceEntry.delete).toHaveBeenCalledWith({
      where: { id: "entry-1" },
    });
    expect(result).toEqual({
      referenceEntryId: "entry-1",
      legacyReferenceId: "legacy-1",
    });
  });

  it("returns null when no reference entry exists for the requested id", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue(null as never);

    const result = await deleteReferenceEntryWithLegacyProjection("paper-1", "missing");

    expect(result).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("findReferenceEntryForPaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up reference entries by either entry id or legacy reference id", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue({ id: "entry-1" } as never);

    await findReferenceEntryForPaper("paper-1", "legacy-1");

    expect(prisma.referenceEntry.findFirst).toHaveBeenCalledWith({
      where: {
        paperId: "paper-1",
        OR: [{ id: "legacy-1" }, { legacyReferenceId: "legacy-1" }],
      },
      select: expect.any(Object),
    });
  });
});

describe("enrichReferenceEntryFromCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates reference entry truth and projects legacy fields in one transaction", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue({
      id: "entry-1",
      paperId: "paper-1",
      legacyReferenceId: "legacy-1",
      title: "Attention Is All You Need",
      authors: null,
      year: 2017,
      venue: null,
      doi: null,
      rawCitation: "Attention Is All You Need",
      referenceIndex: 1,
      semanticScholarId: null,
      arxivId: null,
      externalUrl: null,
      resolvedEntityId: null,
      resolveConfidence: null,
      resolveSource: null,
    } as never);
    vi.mocked(resolveOrCreateEntity).mockResolvedValue({
      entityId: "entity-1",
      created: false,
    });
    vi.mocked(prisma.paper.findFirst).mockResolvedValue({ id: "paper-2" } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: never) =>
      callback({
        reference: {
          create: prisma.reference.create,
          update: prisma.reference.update,
        },
        referenceEntry: {
          update: prisma.referenceEntry.update,
        },
        paper: {
          findFirst: prisma.paper.findFirst,
        },
      }),
    );
    vi.mocked(prisma.referenceEntry.update).mockResolvedValue({
      id: "entry-1",
      legacyReferenceId: "legacy-1",
    } as never);
    vi.mocked(prisma.reference.update).mockResolvedValue({ id: "legacy-1" } as never);

    const result = await enrichReferenceEntryFromCandidate({
      paperId: "paper-1",
      referenceId: "legacy-1",
      userId: "user-1",
      candidate: {
        semanticScholarId: "s2:abc",
        title: "Attention Is All You Need",
        abstract: null,
        authors: ["Ashish Vaswani"],
        year: 2017,
        venue: "NeurIPS",
        doi: "10.5555/3295222.3295349",
        arxivId: null,
        openReviewId: null,
        externalUrl: "https://doi.org/10.5555/3295222.3295349",
        citationCount: 1000,
        openAccessPdfUrl: null,
        source: "s2",
      },
    });

    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      data: expect.objectContaining({
        doi: "10.5555/3295222.3295349",
        semanticScholarId: "s2:abc",
        resolvedEntityId: "entity-1",
        resolveSource: "semantic_scholar_candidate",
      }),
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });
    expect(prisma.reference.update).toHaveBeenCalledWith({
      where: { id: "legacy-1" },
      data: expect.objectContaining({
        doi: "10.5555/3295222.3295349",
        matchedPaperId: "paper-2",
        matchConfidence: 1,
      }),
    });
    expect(result).toEqual({
      referenceEntryId: "entry-1",
      legacyReferenceId: "legacy-1",
      linkedPaperId: "paper-2",
    });
  });
});

describe("projectReferenceEntryImportLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects import-time paper links while only promoting canonical truth when the paper has an entity", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue({
      id: "entry-1",
      paperId: "paper-1",
      legacyReferenceId: "legacy-1",
      title: "Attention Is All You Need",
      authors: null,
      year: 2017,
      venue: "NeurIPS",
      doi: null,
      rawCitation: "Attention Is All You Need",
      referenceIndex: 1,
      semanticScholarId: null,
      arxivId: null,
      externalUrl: null,
      resolvedEntityId: null,
      resolveConfidence: null,
      resolveSource: null,
    } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: never) =>
      callback({
        reference: {
          create: prisma.reference.create,
          update: prisma.reference.update,
        },
        referenceEntry: {
          update: prisma.referenceEntry.update,
        },
        paper: {
          findFirst: prisma.paper.findFirst,
        },
      }),
    );
    vi.mocked(prisma.referenceEntry.update).mockResolvedValue({
      id: "entry-1",
      legacyReferenceId: "legacy-1",
    } as never);
    vi.mocked(prisma.reference.update).mockResolvedValue({ id: "legacy-1" } as never);

    await projectReferenceEntryImportLink({
      paperId: "paper-1",
      referenceId: "legacy-1",
      linkedPaperId: "paper-2",
      linkedPaperEntityId: null,
    });

    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      data: {},
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });
    expect(prisma.reference.update).toHaveBeenCalledWith({
      where: { id: "legacy-1" },
      data: expect.objectContaining({
        matchedPaperId: "paper-2",
        matchConfidence: 1,
      }),
    });
  });
});
