import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    referenceEntry: {
      findMany: vi.fn(),
    },
    paper: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "../../prisma";
import {
  listPaperReferenceViews,
  mapReferenceEntryToView,
} from "../read-model";

describe("mapReferenceEntryToView", () => {
  it("derives canonical local linkage and citation context from reference entries", () => {
    const view = mapReferenceEntryToView(
      {
        id: "entry-1",
        legacyReferenceId: "legacy-1",
        title: "Attention Is All You Need",
        authors: JSON.stringify(["Ashish Vaswani"]),
        year: 2017,
        venue: "NeurIPS",
        doi: "10.5555/3295222.3295349",
        rawCitation: "Attention Is All You Need",
        referenceIndex: 1,
        semanticScholarId: "s2:abc",
        arxivId: "1706.03762",
        externalUrl: "https://arxiv.org/abs/1706.03762",
        resolvedEntityId: "entity-1",
        resolveConfidence: 0.97,
        resolveSource: "doi_exact",
        createdAt: new Date("2026-04-17T10:00:00Z"),
        citationMentions: [
          {
            excerpt: "We follow Vaswani et al. for the base architecture.",
            createdAt: new Date("2026-04-17T10:01:00Z"),
          },
          {
            excerpt: "We follow Vaswani et al. for the base architecture.",
            createdAt: new Date("2026-04-17T10:02:00Z"),
          },
          {
            excerpt: "The attention stack is identical to the original transformer.",
            createdAt: new Date("2026-04-17T10:03:00Z"),
          },
        ],
      },
      new Map([
        [
          "entity-1",
          {
            id: "paper-2",
            entityId: "entity-1",
            title: "Attention Is All You Need",
            year: 2017,
            authors: JSON.stringify(["Ashish Vaswani"]),
            createdAt: new Date("2026-04-16T10:00:00Z"),
          },
        ],
      ]),
      new Map(),
    );

    expect(view.id).toBe("legacy-1");
    expect(view.referenceEntryId).toBe("entry-1");
    expect(view.matchedPaperId).toBe("paper-2");
    expect(view.matchConfidence).toBe(0.97);
    expect(view.linkState).toBe("canonical_entity_linked");
    expect(view.citationContext).toBe(
      "We follow Vaswani et al. for the base architecture.; The attention stack is identical to the original transformer.",
    );
  });

  it("keeps import-dedup-only candidates separate from canonical linked state", () => {
    const view = mapReferenceEntryToView(
      {
        id: "entry-2",
        legacyReferenceId: "legacy-2",
        title: "Scaling Laws for Neural Language Models",
        authors: null,
        year: 2020,
        venue: null,
        doi: null,
        rawCitation: "Scaling Laws for Neural Language Models",
        referenceIndex: 2,
        semanticScholarId: null,
        arxivId: null,
        externalUrl: null,
        resolvedEntityId: null,
        resolveConfidence: null,
        resolveSource: null,
        createdAt: new Date("2026-04-17T10:00:00Z"),
        citationMentions: [],
      },
      new Map(),
      new Map([
        [
          "scaling laws for neural language models",
          {
            id: "paper-3",
            entityId: null,
            title: "Scaling Laws for Neural Language Models",
            year: 2020,
            authors: null,
            createdAt: new Date("2026-04-16T10:00:00Z"),
          },
        ],
      ]),
    );

    expect(view.matchedPaperId).toBeNull();
    expect(view.matchedPaper).toBeNull();
    expect(view.linkState).toBe("import_dedup_only_reusable");
    expect(view.importReusablePaperId).toBe("paper-3");
  });
});

describe("listPaperReferenceViews", () => {
  it("loads and maps entries for the current user's library papers", async () => {
    vi.mocked(prisma.referenceEntry.findMany).mockResolvedValue([
      {
        id: "entry-1",
        legacyReferenceId: "legacy-1",
        title: "Attention Is All You Need",
        authors: JSON.stringify(["Ashish Vaswani"]),
        year: 2017,
        venue: "NeurIPS",
        doi: "10.5555/3295222.3295349",
        rawCitation: "Attention Is All You Need",
        referenceIndex: 1,
        semanticScholarId: null,
        arxivId: null,
        externalUrl: null,
        resolvedEntityId: "entity-1",
        resolveConfidence: 1,
        resolveSource: "doi_exact",
        createdAt: new Date("2026-04-17T10:00:00Z"),
        citationMentions: [],
      },
    ] as never);
    vi.mocked(prisma.paper.findMany).mockResolvedValue([
      {
        id: "paper-2",
        entityId: "entity-1",
        title: "Attention Is All You Need",
        year: 2017,
        authors: JSON.stringify(["Ashish Vaswani"]),
        createdAt: new Date("2026-04-16T10:00:00Z"),
      },
    ] as never);

    const views = await listPaperReferenceViews("paper-1", "user-1");

    expect(prisma.referenceEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paperId: "paper-1" },
      }),
    );
    expect(prisma.paper.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          id: { not: "paper-1" },
        },
      }),
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.matchedPaperId).toBe("paper-2");
  });
});
