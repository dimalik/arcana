import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {},
}));

vi.mock("../../canonical/import-dedup", () => ({
  hydratePaperEntityIfPossible: vi.fn(),
  inspectPaperEntityHydration: vi.fn(),
}));

vi.mock("../reference-entry-service", () => ({
  createReferenceEntry: vi.fn(),
  resolveReferenceEntity: vi.fn(),
}));

import { classifyTitleHintResidual } from "../backfill-references";

describe("classifyTitleHintResidual", () => {
  it("returns null when canonical local linkage already exists", () => {
    const result = classifyTitleHintResidual({
      legacyReference: {
        id: "legacy-1",
        paperId: "paper-1",
        title: "Attention Is All You Need",
        authors: null,
        year: 2017,
        venue: "NeurIPS",
        doi: "10.5555/3295222.3295349",
        arxivId: null,
        externalUrl: null,
        semanticScholarId: null,
        rawCitation: "Attention Is All You Need",
        referenceIndex: 1,
        matchedPaperId: "paper-2",
      },
      referenceEntry: {
        id: "entry-1",
        paperId: "paper-1",
        legacyReferenceId: "legacy-1",
        resolvedEntityId: "entity-2",
      },
      matchedPaper: {
        id: "paper-2",
        title: "Attention Is All You Need",
        userId: "user-1",
        authors: null,
        year: 2017,
        venue: "NeurIPS",
        abstract: null,
        doi: "10.5555/3295222.3295349",
        arxivId: null,
        semanticScholarId: null,
        entityId: "entity-2",
      },
    });

    expect(result).toBeNull();
  });

  it("classifies DOI-correlated title hints as strong-identifier promotable", () => {
    const result = classifyTitleHintResidual({
      legacyReference: {
        id: "legacy-1",
        paperId: "paper-1",
        title: "Attention Is All You Need",
        authors: null,
        year: 2017,
        venue: "NeurIPS",
        doi: "https://doi.org/10.5555/3295222.3295349",
        arxivId: null,
        externalUrl: null,
        semanticScholarId: null,
        rawCitation: "Attention Is All You Need",
        referenceIndex: 1,
        matchedPaperId: "paper-2",
      },
      referenceEntry: {
        id: "entry-1",
        paperId: "paper-1",
        legacyReferenceId: "legacy-1",
        resolvedEntityId: null,
      },
      matchedPaper: {
        id: "paper-2",
        title: "Attention Is All You Need",
        userId: "user-1",
        authors: null,
        year: 2017,
        venue: "NeurIPS",
        abstract: null,
        doi: "10.5555/3295222.3295349",
        arxivId: null,
        semanticScholarId: null,
        entityId: "entity-2",
      },
    });

    expect(result?.classification).toBe("strong_identifier_promotable");
    expect(result?.matchedBy).toBe("doi");
  });

  it("keeps pure title hints in the audit bucket", () => {
    const result = classifyTitleHintResidual({
      legacyReference: {
        id: "legacy-1",
        paperId: "paper-1",
        title: "Attention Is All You Need",
        authors: null,
        year: 2017,
        venue: "NeurIPS",
        doi: null,
        arxivId: null,
        externalUrl: null,
        semanticScholarId: null,
        rawCitation: "Attention Is All You Need",
        referenceIndex: 1,
        matchedPaperId: "paper-2",
      },
      referenceEntry: {
        id: "entry-1",
        paperId: "paper-1",
        legacyReferenceId: "legacy-1",
        resolvedEntityId: null,
      },
      matchedPaper: {
        id: "paper-2",
        title: "Attention Is All You Need",
        userId: "user-1",
        authors: null,
        year: 2017,
        venue: "NeurIPS",
        abstract: null,
        doi: null,
        arxivId: null,
        semanticScholarId: null,
        entityId: null,
      },
    });

    expect(result?.classification).toBe("audit_bucket");
    expect(result?.matchedBy).toBe("none");
  });
});
