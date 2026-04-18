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
      count: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    paper: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
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
  referenceEntryNeedsMetadataRepair,
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
    vi.mocked(prisma.reference.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.paper.findUnique).mockResolvedValue({
      id: "paper-1",
      filePath: "/tmp/paper.pdf",
      fullText: null,
      processingStatus: "COMPLETED",
      referenceState: "available",
    } as never);
    vi.mocked(prisma.paper.update).mockResolvedValue({ id: "paper-1" } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      (callback as (tx: unknown) => unknown)({
        reference: {
          count: prisma.reference.count,
          deleteMany: prisma.reference.deleteMany,
        },
        referenceEntry: {
          delete: prisma.referenceEntry.delete,
        },
        paper: {
          findUnique: prisma.paper.findUnique,
          update: prisma.paper.update,
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
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      (callback as (tx: unknown) => unknown)({
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
        title: "Attention Is All You Need",
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
        title: "Attention Is All You Need",
        doi: "10.5555/3295222.3295349",
        matchedPaperId: "paper-2",
        matchConfidence: 1,
      }),
    });
    expect(result).toEqual({
      referenceEntryId: "entry-1",
      legacyReferenceId: "legacy-1",
      linkedPaperId: "paper-2",
      mergeSummary: {
        title: "kept_trusted_local",
        authors: "filled_missing",
        venue: "filled_missing",
        identifiersPersisted: true,
        resolutionUpdated: true,
      },
    });
  });

  it("replaces polluted metadata fields with trusted online candidate values", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue({
      id: "entry-2",
      paperId: "paper-1",
      legacyReferenceId: "legacy-2",
      title:
        "FDL + 24] Chaoyou Fu, Yuhan Dai, Yondong Luo, Lei Li, Shuhuai Ren, Renrui Zhang. Video-mme: The first-ever comprehensive evaluation benchmark of multi-modal llms in video analysis. 2024.",
      authors: JSON.stringify(["Chaoyou FDL + 24] Fu", "Yuhan Dai"]),
      year: 2024,
      venue: "FDL + 24",
      doi: null,
      rawCitation:
        "FDL + 24] Chaoyou Fu, Yuhan Dai, Yondong Luo, Lei Li, Shuhuai Ren, Renrui Zhang. Video-mme: The first-ever comprehensive evaluation benchmark of multi-modal llms in video analysis. arXiv preprint arXiv:2405.21075, 2024.",
      referenceIndex: 2,
      semanticScholarId: null,
      arxivId: null,
      externalUrl: null,
      resolvedEntityId: null,
      resolveConfidence: null,
      resolveSource: null,
    } as never);
    vi.mocked(resolveOrCreateEntity).mockResolvedValue({
      entityId: "entity-video-mme",
      created: false,
    });
    vi.mocked(prisma.paper.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      (callback as (tx: unknown) => unknown)({
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
      id: "entry-2",
      legacyReferenceId: "legacy-2",
    } as never);
    vi.mocked(prisma.reference.update).mockResolvedValue({ id: "legacy-2" } as never);

    const result = await enrichReferenceEntryFromCandidate({
      paperId: "paper-1",
      referenceId: "legacy-2",
      userId: "user-1",
      candidate: {
        semanticScholarId: "https://openalex.org/W123",
        title:
          "Video-MME: The First-Ever Comprehensive Evaluation Benchmark of Multi-modal LLMs in Video Analysis",
        abstract: null,
        authors: ["Chaoyou Fu", "Yuhan Dai", "Yongdong Luo"],
        year: 2025,
        venue: "CVPR",
        doi: "10.1109/CVPR.2025.12345",
        arxivId: "2405.21075",
        openReviewId: null,
        externalUrl: "https://openaccess.thecvf.com/content/CVPR2025/html/example.html",
        citationCount: 20,
        openAccessPdfUrl: null,
        source: "openalex",
      },
    });

    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-2" },
      data: expect.objectContaining({
        title:
          "Video-MME: The First-Ever Comprehensive Evaluation Benchmark of Multi-modal LLMs in Video Analysis",
        authors: JSON.stringify(["Chaoyou Fu", "Yuhan Dai", "Yongdong Luo"]),
        venue: "CVPR",
        doi: "10.1109/CVPR.2025.12345",
        arxivId: "2405.21075",
        semanticScholarId: "https://openalex.org/W123",
        resolvedEntityId: "entity-video-mme",
        resolveSource: "openalex_candidate",
      }),
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });
    expect(prisma.reference.update).toHaveBeenCalledWith({
      where: { id: "legacy-2" },
      data: expect.objectContaining({
        title:
          "Video-MME: The First-Ever Comprehensive Evaluation Benchmark of Multi-modal LLMs in Video Analysis",
        authors: JSON.stringify(["Chaoyou Fu", "Yuhan Dai", "Yongdong Luo"]),
        venue: "CVPR",
      }),
    });
    expect(result?.mergeSummary).toEqual({
      title: "replaced_polluted",
      authors: "replaced_polluted",
      venue: "replaced_polluted",
      identifiersPersisted: true,
      resolutionUpdated: true,
    });
  });

  it("keeps trusted local metadata instead of overwriting it with weaker candidate fields", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue({
      id: "entry-3",
      paperId: "paper-1",
      legacyReferenceId: "legacy-3",
      title: "Video-mme: The first-ever comprehensive evaluation benchmark of multi-modal llms in video analysis",
      authors: JSON.stringify(["Chaoyou Fu", "Yuhan Dai"]),
      year: 2024,
      venue: "arXiv preprint arXiv:2405.21075",
      doi: null,
      rawCitation: "Video-MME",
      referenceIndex: 3,
      semanticScholarId: null,
      arxivId: null,
      externalUrl: null,
      resolvedEntityId: null,
      resolveConfidence: null,
      resolveSource: null,
    } as never);
    vi.mocked(resolveOrCreateEntity).mockResolvedValue({
      entityId: "entity-3",
      created: false,
    });
    vi.mocked(prisma.paper.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      (callback as (tx: unknown) => unknown)({
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
      id: "entry-3",
      legacyReferenceId: "legacy-3",
    } as never);
    vi.mocked(prisma.reference.update).mockResolvedValue({ id: "legacy-3" } as never);

    const result = await enrichReferenceEntryFromCandidate({
      paperId: "paper-1",
      referenceId: "legacy-3",
      userId: "user-1",
      candidate: {
        semanticScholarId: "s2:video-mme",
        title: "Video-MME",
        abstract: null,
        authors: ["Different Author"],
        year: 2025,
        venue: "CVPR",
        doi: null,
        arxivId: null,
        openReviewId: null,
        externalUrl: "https://example.com/video-mme",
        citationCount: 20,
        openAccessPdfUrl: null,
        source: "s2",
      },
    });

    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-3" },
      data: expect.objectContaining({
        title: "Video-mme: The first-ever comprehensive evaluation benchmark of multi-modal llms in video analysis",
        authors: JSON.stringify(["Chaoyou Fu", "Yuhan Dai"]),
        venue: "arXiv preprint arXiv:2405.21075",
      }),
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });
    expect(result?.mergeSummary).toEqual({
      title: "kept_trusted_local",
      authors: "kept_trusted_local",
      venue: "kept_trusted_local",
      identifiersPersisted: true,
      resolutionUpdated: true,
    });
  });

  it("does not mutate resolution state on metadata-only repair without new identifiers", async () => {
    vi.mocked(prisma.referenceEntry.findFirst).mockResolvedValue({
      id: "entry-4",
      paperId: "paper-1",
      legacyReferenceId: "legacy-4",
      title:
        "JSM + 23] Albert Q. Jiang, Alexandre Sablayrolles. Mistral 7b, 2023.",
      authors: JSON.stringify(["Q Jsm + 23] Albert", "Alexandre Sablayrolles"]),
      year: 2023,
      venue: null,
      doi: null,
      rawCitation:
        "JSM + 23] Albert Q. Jiang, Alexandre Sablayrolles. Mistral 7b, 2023.",
      referenceIndex: 4,
      semanticScholarId: null,
      arxivId: null,
      externalUrl: null,
      resolvedEntityId: "entity-existing",
      resolveConfidence: 0.88,
      resolveSource: "title_author_fuzzy",
    } as never);
    vi.mocked(prisma.paper.findFirst).mockResolvedValue({ id: "paper-existing" } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      (callback as (tx: unknown) => unknown)({
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
      id: "entry-4",
      legacyReferenceId: "legacy-4",
    } as never);
    vi.mocked(prisma.reference.update).mockResolvedValue({ id: "legacy-4" } as never);

    const result = await enrichReferenceEntryFromCandidate({
      paperId: "paper-1",
      referenceId: "legacy-4",
      userId: "user-1",
      candidate: {
        semanticScholarId: null,
        title: "Mistral 7b",
        abstract: null,
        authors: ["Albert Q. Jiang", "Alexandre Sablayrolles"],
        year: 2023,
        venue: null,
        doi: null,
        arxivId: null,
        openReviewId: null,
        externalUrl: "",
        citationCount: 20,
        openAccessPdfUrl: null,
        source: "crossref",
      },
    });

    expect(resolveOrCreateEntity).not.toHaveBeenCalled();
    expect(prisma.referenceEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-4" },
      data: expect.objectContaining({
        title: "Mistral 7b",
        authors: JSON.stringify(["Albert Q. Jiang", "Alexandre Sablayrolles"]),
        resolvedEntityId: "entity-existing",
        resolveConfidence: 0.88,
        resolveSource: "title_author_fuzzy",
      }),
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });
    expect(result?.mergeSummary).toEqual({
      title: "replaced_polluted",
      authors: "replaced_polluted",
      venue: "no_trustworthy_upgrade",
      identifiersPersisted: false,
      resolutionUpdated: false,
    });
  });
});

describe("referenceEntryNeedsMetadataRepair", () => {
  it("flags polluted title, authors, or venue values", () => {
    expect(
      referenceEntryNeedsMetadataRepair({
        title: "Clean Title",
        authors: JSON.stringify(["Alice Example"]),
        venue: "NeurIPS",
      }),
    ).toBe(false);

    expect(
      referenceEntryNeedsMetadataRepair({
        title: "FDL + 24] Video-MME",
        authors: JSON.stringify(["Alice Example"]),
        venue: "NeurIPS",
      }),
    ).toBe(true);

    expect(
      referenceEntryNeedsMetadataRepair({
        title: "JSM + 23] Albert Q. Jiang, Alexandre Sablayrolles. Mistral 7b, 2023.",
        authors: JSON.stringify(["Alice Example"]),
        venue: "NeurIPS",
      }),
    ).toBe(true);

    expect(
      referenceEntryNeedsMetadataRepair({
        title: "Video-MME",
        authors: JSON.stringify(["Alice FDL + 24] Example"]),
        venue: "NeurIPS",
      }),
    ).toBe(true);

    expect(
      referenceEntryNeedsMetadataRepair({
        title: "Video-MME",
        authors: JSON.stringify(["Alice Example"]),
        venue: "FDL + 24",
      }),
    ).toBe(true);
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
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      (callback as (tx: unknown) => unknown)({
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
