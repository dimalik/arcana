import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    citationMention: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    referenceEntry: {
      findMany: vi.fn(),
    },
    reference: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../../references/match-citation", () => ({
  matchCitationToReference: vi.fn(),
}));

import {
  createCitationMentions,
  replaceCitationMentionsWithLegacyProjection,
} from "../citation-mention-service";

describe("createCitationMentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates mentions for matched citations", async () => {
    const { prisma } = await import("../../prisma");
    const { matchCitationToReference } = await import("../../references/match-citation");
    (prisma.referenceEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "ref-1", title: "Attention", authors: null, year: 2017, referenceIndex: 1 },
    ]);
    (matchCitationToReference as ReturnType<typeof vi.fn>).mockReturnValue("ref-1");
    (prisma.citationMention.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mention-1" });

    const result = await createCitationMentions("paper-1", [
      {
        citationText: "Vaswani et al., 2017",
        excerpt: "The transformer (Vaswani et al., 2017) changed NLP.",
        sectionLabel: "Introduction",
      },
    ], "v1");

    expect(result).toEqual({ created: 1, unmatched: 0 });
  });

  it("matches directly by referenceIndex when provided", async () => {
    const { prisma } = await import("../../prisma");
    const { matchCitationToReference } = await import("../../references/match-citation");
    (prisma.referenceEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "ref-2", title: "BinaryBERT", authors: null, year: 2021, referenceIndex: 4 },
    ]);
    (prisma.citationMention.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mention-2" });

    const result = await createCitationMentions(
      "paper-1",
      [
        {
          citationText: "Chen et al. (2023)",
          excerpt: "Skip/SmartBERT added trainable gates for cheaper inference.",
          referenceIndex: 4,
          sectionLabel: "1 Introduction",
        },
      ],
      "grobid_fulltext_v1",
      "grobid_fulltext",
    );

    expect(result).toEqual({ created: 1, unmatched: 0 });
    expect(matchCitationToReference).not.toHaveBeenCalled();
    expect(prisma.citationMention.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        referenceEntryId: "ref-2",
        provenance: "grobid_fulltext",
        extractorVersion: "grobid_fulltext_v1",
      }),
    });
  });

  it("replaces existing mentions and legacy contexts before reapplying them", async () => {
    const { prisma } = await import("../../prisma");
    const { matchCitationToReference } = await import("../../references/match-citation");
    (prisma.referenceEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "ref-1", title: "Attention", authors: null, year: 2017, referenceIndex: 1 },
    ]);
    (prisma.reference.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "legacy-1", title: "Attention", authors: null, year: 2017, referenceIndex: 1 },
    ]);
    (prisma.citationMention.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
    (prisma.reference.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.citationMention.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mention-1" });
    (prisma.reference.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "legacy-1" });
    (matchCitationToReference as ReturnType<typeof vi.fn>).mockReturnValue("ref-1");

    const result = await replaceCitationMentionsWithLegacyProjection(
      "paper-1",
      [
        {
          citationText: "Vaswani et al., 2017",
          excerpt: "The transformer (Vaswani et al., 2017) changed NLP.",
        },
      ],
      "v1",
    );

    expect(prisma.citationMention.deleteMany).toHaveBeenCalledWith({
      where: { paperId: "paper-1" },
    });
    expect(prisma.reference.updateMany).toHaveBeenCalledWith({
      where: { paperId: "paper-1" },
      data: { citationContext: null },
    });
    expect(result).toEqual({
      created: 1,
      unmatched: 0,
      legacyUpdated: 1,
    });
  });
});
