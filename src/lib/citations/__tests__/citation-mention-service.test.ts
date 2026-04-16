import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma", () => ({
  prisma: {
    citationMention: {
      create: vi.fn(),
    },
    referenceEntry: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../../references/match-citation", () => ({
  matchCitationToReference: vi.fn(),
}));

import { createCitationMentions } from "../citation-mention-service";

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
});
