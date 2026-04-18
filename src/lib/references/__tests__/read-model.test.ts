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

  it("sanitizes polluted author lists derived from citation-key-prefixed raw citations", () => {
    const view = mapReferenceEntryToView(
      {
        id: "entry-3",
        legacyReferenceId: "legacy-3",
        title: "Program synthesis with large language models",
        authors: JSON.stringify([
          "Augustus Aon + 21] Jacob Austin",
          "Maxwell Odena",
          "Maarten Nye",
        ]),
        year: 2021,
        venue: "arXiv",
        doi: null,
        rawCitation:
          "AON + 21] Jacob Austin, Augustus Odena, Maxwell Nye, Maarten Bosma, Henryk Michalewski, David Dohan, Ellen Jiang, Carrie Cai, Michael Terry, Quoc Le, and Charles Sutton. Program synthesis with large language models. arXiv preprint arXiv:2108.07732, 2021.",
        referenceIndex: 3,
        semanticScholarId: null,
        arxivId: "2108.07732",
        externalUrl: null,
        resolvedEntityId: null,
        resolveConfidence: null,
        resolveSource: null,
        createdAt: new Date("2026-04-18T10:00:00Z"),
        citationMentions: [],
      },
      new Map(),
      new Map(),
    );

    expect(view.title).toBe("Program synthesis with large language models");
    expect(JSON.parse(view.authors ?? "[]")).toEqual(
      expect.arrayContaining(["Jacob Austin", "Augustus Odena", "Charles Sutton"]),
    );
    expect(view.rawCitation.startsWith("AON + 21]")).toBe(false);
  });

  it("derives a clean display title when the stored title is the full raw citation", () => {
    const view = mapReferenceEntryToView(
      {
        id: "entry-4",
        legacyReferenceId: "legacy-4",
        title:
          "JSM + 23] Albert Q. Jiang, Alexandre Sablayrolles, Arthur Mensch, Chris Bamford, Devendra Singh Chaplot, Diego de las Casas, Florian Bressand, Gianna Lengyel, Guillaume Lample, Lucile Saulnier, Lélio Renard Lavaud, Marie-Anne Lachaux, Pierre Stock, Teven Le Scao, Thibaut Lavril, Thomas Wang, Timothée Lacroix, and William El Sayed. Mistral 7b, 2023.",
        authors: JSON.stringify([
          "Q Jsm + 23] Albert",
          "Alexandre Jiang",
          "Arthur Sablayrolles",
        ]),
        year: 2023,
        venue: null,
        doi: null,
        rawCitation:
          "JSM + 23] Albert Q. Jiang, Alexandre Sablayrolles, Arthur Mensch, Chris Bamford, Devendra Singh Chaplot, Diego de las Casas, Florian Bressand, Gianna Lengyel, Guillaume Lample, Lucile Saulnier, Lélio Renard Lavaud, Marie-Anne Lachaux, Pierre Stock, Teven Le Scao, Thibaut Lavril, Thomas Wang, Timothée Lacroix, and William El Sayed. Mistral 7b, 2023.",
        referenceIndex: 4,
        semanticScholarId: null,
        arxivId: null,
        externalUrl: null,
        resolvedEntityId: null,
        resolveConfidence: null,
        resolveSource: null,
        createdAt: new Date("2026-04-18T10:00:00Z"),
        citationMentions: [],
      },
      new Map(),
      new Map([
        [
          "mistral 7b",
          {
            id: "paper-4",
            entityId: null,
            title: "Mistral 7b",
            year: 2023,
            authors: null,
            createdAt: new Date("2026-04-17T10:00:00Z"),
          },
        ],
      ]),
    );

    expect(view.title).toBe("Mistral 7b");
    expect(JSON.parse(view.authors ?? "[]")).toEqual(
      expect.arrayContaining(["Albert Q. Jiang", "Alexandre Sablayrolles", "William El Sayed"]),
    );
    expect(view.linkState).toBe("unresolved");
    expect(view.importReusablePaperId).toBeNull();
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
