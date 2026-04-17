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

vi.mock("../../canonical/entity-service", () => ({
  resolveOrCreateEntity: vi.fn(),
}));

vi.mock("../../references/resolve", () => ({
  resolveReferenceOnline: vi.fn(),
}));

import { prisma } from "../../prisma";
import { resolveOrCreateEntity } from "../../canonical/entity-service";
import { resolveReferenceOnline } from "../../references/resolve";
import { createReferenceEntry, resolveReferenceEntity } from "../reference-entry-service";

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
