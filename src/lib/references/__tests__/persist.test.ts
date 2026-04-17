import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    reference: {
      deleteMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    citationMention: {
      deleteMany: vi.fn(),
    },
    referenceEntry: {
      deleteMany: vi.fn(),
    },
    paper: {
      findMany: vi.fn(),
    },
    paperRelation: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../../citations/reference-entry-service", () => ({
  createReferenceEntry: vi.fn(),
  resolveReferenceEntity: vi.fn(),
}));

vi.mock("../../assertions/relation-assertion-service", () => ({
  createRelationAssertion: vi.fn(),
}));

vi.mock("../../assertions/legacy-projection", () => ({
  projectLegacyRelation: vi.fn(),
}));

import { prisma } from "../../prisma";
import {
  createReferenceEntry,
  resolveReferenceEntity,
} from "../../citations/reference-entry-service";
import { createRelationAssertion } from "../../assertions/relation-assertion-service";
import { projectLegacyRelation } from "../../assertions/legacy-projection";
import { persistExtractedReferences } from "../persist";

describe("persistExtractedReferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.reference.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.citationMention.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.referenceEntry.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.reference.create).mockResolvedValue({ id: "legacy-1" } as never);
    vi.mocked(prisma.reference.update).mockResolvedValue({ id: "legacy-1" } as never);
    vi.mocked(prisma.paperRelation.create).mockReturnValue({
      catch: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.mocked(createReferenceEntry).mockResolvedValue({ id: "entry-1" } as never);
  });

  it("keeps title-only matches as hints without promoting graph edges", async () => {
    vi.mocked(prisma.paper.findMany).mockResolvedValue([
      {
        id: "paper-2",
        title: "Attention Is All You Need",
        entityId: "entity-2",
        doi: null,
        arxivId: null,
      },
    ] as never);
    vi.mocked(resolveReferenceEntity).mockResolvedValue({
      resolvedEntityId: null,
      resolveConfidence: null,
      resolveSource: null,
      matchedFieldCount: 0,
      matchedIdentifiers: [],
      evidence: [],
      semanticScholarId: null,
      externalUrl: null,
    });

    const result = await persistExtractedReferences({
      paperId: "paper-1",
      paperUserId: "user-1",
      sourceEntityId: "entity-1",
      provenance: "llm_extraction",
      extractorVersion: "v1",
      references: [
        {
          referenceIndex: 1,
          rawCitation: "Attention Is All You Need",
          title: "Attention Is All You Need",
          authors: ["Ashish Vaswani"],
          year: 2017,
          venue: "NeurIPS",
          doi: null,
          arxivId: null,
          extractionMethod: "llm_repair",
          extractionConfidence: 0.55,
        },
      ],
    });

    expect(prisma.reference.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchedPaperId: "paper-2",
          matchConfidence: expect.any(Number),
        }),
      }),
    );
    expect(prisma.paperRelation.create).not.toHaveBeenCalled();
    expect(createRelationAssertion).not.toHaveBeenCalled();
    expect(projectLegacyRelation).not.toHaveBeenCalled();
    expect(result.promotedPaperEdges).toBe(0);
    expect(result.titleHintMatches).toBe(1);
  });

  it("promotes a paper edge and assertion for exact DOI matches", async () => {
    vi.mocked(prisma.paper.findMany).mockResolvedValue([
      {
        id: "paper-2",
        title: "Attention Is All You Need",
        entityId: "entity-2",
        doi: "https://doi.org/10.5555/3295222.3295349",
        arxivId: null,
      },
    ] as never);
    vi.mocked(resolveReferenceEntity).mockResolvedValue({
      resolvedEntityId: "entity-2",
      resolveConfidence: 1,
      resolveSource: "doi_exact",
      matchedFieldCount: 1,
      matchedIdentifiers: [{ type: "doi", value: "10.5555/3295222.3295349" }],
      evidence: ["doi_exact"],
      semanticScholarId: null,
      externalUrl: null,
    });

    const result = await persistExtractedReferences({
      paperId: "paper-1",
      paperUserId: "user-1",
      sourceEntityId: "entity-1",
      provenance: "grobid_tei",
      extractorVersion: "grobid_v1",
      references: [
        {
          referenceIndex: 1,
          rawCitation: "Attention Is All You Need",
          title: "Attention Is All You Need",
          authors: ["Ashish Vaswani"],
          year: 2017,
          venue: "NeurIPS",
          doi: "10.5555/3295222.3295349",
          arxivId: null,
          extractionMethod: "grobid_tei",
          extractionConfidence: 0.9,
        },
      ],
    });

    expect(prisma.paperRelation.create).toHaveBeenCalled();
    expect(createRelationAssertion).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEntityId: "entity-1",
        targetEntityId: "entity-2",
        provenance: "reference_match",
      }),
    );
    expect(projectLegacyRelation).toHaveBeenCalledWith(
      "paper-1",
      "paper-2",
      "entity-1",
      "entity-2",
      true,
    );
    expect(result.promotedPaperEdges).toBe(1);
    expect(result.promotedEntityAssertions).toBe(1);
  });

  it("promotes via resolved canonical entity when that entity maps to a local paper", async () => {
    vi.mocked(prisma.paper.findMany).mockResolvedValue([
      {
        id: "paper-2",
        title: "Canonical local paper",
        entityId: "entity-2",
        doi: null,
        arxivId: null,
      },
    ] as never);
    vi.mocked(resolveReferenceEntity).mockResolvedValue({
      resolvedEntityId: "entity-2",
      resolveConfidence: 1,
      resolveSource: "doi_exact",
      matchedFieldCount: 1,
      matchedIdentifiers: [{ type: "doi", value: "10.1234/canonical" }],
      evidence: ["doi_exact"],
      semanticScholarId: null,
      externalUrl: null,
    });

    const result = await persistExtractedReferences({
      paperId: "paper-1",
      paperUserId: "user-1",
      sourceEntityId: "entity-1",
      provenance: "grobid_tei",
      extractorVersion: "grobid_v1",
      references: [
        {
          referenceIndex: 1,
          rawCitation: "Canonical local paper",
          title: "Canonical local paper",
          authors: ["Jane Doe"],
          year: 2020,
          venue: "ACL",
          doi: "10.1234/canonical",
          arxivId: null,
          extractionMethod: "grobid_tei",
          extractionConfidence: 0.9,
        },
      ],
    });

    expect(prisma.paperRelation.create).toHaveBeenCalled();
    expect(result.promotedPaperEdges).toBe(1);
    expect(result.promotedEntityAssertions).toBe(1);
  });

  it("does not promote low-confidence candidate resolutions into graph edges", async () => {
    vi.mocked(prisma.paper.findMany).mockResolvedValue([
      {
        id: "paper-2",
        title: "Canonical local paper",
        entityId: "entity-2",
        doi: null,
        arxivId: null,
      },
    ] as never);
    vi.mocked(resolveReferenceEntity).mockResolvedValue({
      resolvedEntityId: "entity-2",
      resolveConfidence: 0.88,
      resolveSource: "openalex_candidate",
      matchedFieldCount: 2,
      matchedIdentifiers: [{ type: "openalex", value: "https://openalex.org/W123" }],
      evidence: ["title:0.93", "year:2020"],
      semanticScholarId: "https://openalex.org/W123",
      externalUrl: "https://openalex.org/W123",
    });

    const result = await persistExtractedReferences({
      paperId: "paper-1",
      paperUserId: "user-1",
      sourceEntityId: "entity-1",
      provenance: "grobid_tei",
      extractorVersion: "grobid_v1",
      references: [
        {
          referenceIndex: 1,
          rawCitation: "Canonical local paper",
          title: "Canonical local paper",
          authors: ["Jane Doe"],
          year: 2020,
          venue: "ACL",
          doi: null,
          arxivId: null,
          extractionMethod: "grobid_tei",
          extractionConfidence: 0.9,
        },
      ],
    });

    expect(prisma.paperRelation.create).not.toHaveBeenCalled();
    expect(createRelationAssertion).not.toHaveBeenCalled();
    expect(result.promotedPaperEdges).toBe(0);
    expect(result.promotedEntityAssertions).toBe(0);
  });
});
