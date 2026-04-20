import { describe, expect, it } from "vitest";

import {
  parseSearchQuery,
  searchLibraryPapers,
  shouldRunSemanticSearch,
} from "./search";

function makeLexicalSeeds(count: number) {
  return new Map(
    Array.from({ length: count }, (_, index) => [
      `paper-${index}`,
      {
        paperId: `paper-${index}`,
        lexicalMatchKinds: new Set(["title" as const]),
        authorIndexHits: 0,
        semanticScore: 0,
        strongTitlePhraseHit: false,
      },
    ]),
  );
}

function makePaper(id: string, title: string, citationCount = 0) {
  return {
    id,
    userId: "user-1",
    title,
    abstract: null,
    authors: JSON.stringify(["Example Author"]),
    year: 2024,
    venue: null,
    doi: null,
    arxivId: null,
    sourceType: "UPLOAD",
    sourceUrl: null,
    summary: null,
    citationCount,
    engagementScore: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    duplicateState: "ACTIVE",
    isResearchOnly: false,
    tags: [],
    collections: [],
    paperAuthors: [],
  };
}

interface MockPaperWhere {
  AND?: MockPaperWhere[];
  OR?: MockPaperWhere[];
  userId?: string;
  duplicateState?: string;
  isResearchOnly?: boolean;
  id?: {
    in?: string[];
    not?: string;
  };
  title?: { contains?: string };
  abstract?: { contains?: string };
  summary?: { contains?: string };
  doi?: { contains?: string };
  arxivId?: { contains?: string };
  sourceUrl?: { contains?: string };
  tags?: {
    some?: {
      tag?: {
        name?: {
          contains?: string;
        };
      };
    };
  };
}

function matchesPaperWhere(
  paper: ReturnType<typeof makePaper>,
  where: MockPaperWhere | undefined,
): boolean {
  if (!where) return true;
  if (Array.isArray(where.AND)) {
    return where.AND.every((clause) => matchesPaperWhere(paper, clause));
  }
  if (Array.isArray(where.OR)) {
    return where.OR.some((clause) => matchesPaperWhere(paper, clause));
  }
  if (where.userId && paper.userId !== where.userId) return false;
  if (where.duplicateState && paper.duplicateState !== where.duplicateState) return false;
  if (typeof where.isResearchOnly === "boolean" && paper.isResearchOnly !== where.isResearchOnly) {
    return false;
  }
  if (where.id?.in && !where.id.in.includes(paper.id)) return false;
  if (where.id?.not && paper.id === where.id.not) return false;
  if (where.title?.contains && !paper.title.toLowerCase().includes(String(where.title.contains).toLowerCase())) {
    return false;
  }
  if (where.abstract?.contains && !(paper.abstract ?? "").toLowerCase().includes(String(where.abstract.contains).toLowerCase())) {
    return false;
  }
  if (where.summary?.contains && !(paper.summary ?? "").toLowerCase().includes(String(where.summary.contains).toLowerCase())) {
    return false;
  }
  if (where.doi?.contains && !(paper.doi ?? "").toLowerCase().includes(String(where.doi.contains).toLowerCase())) {
    return false;
  }
  if (where.arxivId?.contains && !(paper.arxivId ?? "").toLowerCase().includes(String(where.arxivId.contains).toLowerCase())) {
    return false;
  }
  if (where.sourceUrl?.contains && !(paper.sourceUrl ?? "").toLowerCase().includes(String(where.sourceUrl.contains).toLowerCase())) {
    return false;
  }
  const tagNameContains = where.tags?.some?.tag?.name?.contains;
  if (tagNameContains) {
    return paper.tags.some((entry: { tag: { name: string } }) =>
      entry.tag.name
        .toLowerCase()
        .includes(String(tagNameContains).toLowerCase()),
    );
  }
  return true;
}

describe("paper search query heuristics", () => {
  it("classifies exact identifiers and broad title queries", () => {
    const doiQuery = parseSearchQuery("10.65215/2q58a426");
    expect(doiQuery.doiExact).toBe("10.65215/2q58a426");
    expect(doiQuery.broadQuery).toBe(false);

    const broadQuery = parseSearchQuery("transformer");
    expect(broadQuery.broadQuery).toBe(true);
    expect(broadQuery.likelyExactTitleQuery).toBe(false);
  });

  it("treats long colon-delimited titles as exact-title intent", () => {
    const query = parseSearchQuery(
      "FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning",
    );

    expect(query.likelyExactTitleQuery).toBe(true);
    expect(query.likelyAuthorQuery).toBe(false);
  });

  it("keeps likely author queries off the semantic path", () => {
    const authorQuery = parseSearchQuery("Tri Dao");
    expect(authorQuery.likelyAuthorQuery).toBe(true);
    expect(shouldRunSemanticSearch(authorQuery, makeLexicalSeeds(0))).toBe(false);
  });

  it("only enables semantic search for low-recall concept queries", () => {
    const conceptQuery = parseSearchQuery("instruction tuning");
    expect(shouldRunSemanticSearch(conceptQuery, makeLexicalSeeds(0))).toBe(true);
    expect(shouldRunSemanticSearch(conceptQuery, makeLexicalSeeds(8))).toBe(false);
  });

  it("keeps multi-token title phrase searches on the lexical path and ranks prefix matches first", async () => {
    const papers = [
      makePaper(
        "target",
        "Reward Shaping for Reinforcement Learning with An Assistant Reward Agent",
      ),
      makePaper(
        "other-title-hit",
        "Plan-based Reward Shaping for Reinforcement Learning",
        25,
      ),
      makePaper(
        "semantic-decoy",
        "Synthetic Alignment Signals for Diffusion Boundary Detection",
        200,
      ),
    ];

    const db = {
      paper: {
        findMany: async ({ where }: { where: MockPaperWhere }) =>
          papers.filter((paper) => matchesPaperWhere(paper, where)),
      },
      author: {
        findMany: async () => [],
      },
      paperAuthor: {
        findMany: async () => [],
      },
      paperRepresentation: {
        findMany: async () => [],
      },
    };

    const result = await searchLibraryPapers(
      {
        userId: "user-1",
        queryText: "reward shaping",
        where: {
          userId: "user-1",
          duplicateState: "ACTIVE",
          isResearchOnly: false,
        },
        page: 1,
        limit: 5,
      },
      db as never,
    );

    expect(result.papers.map((paper) => paper.id)).toEqual([
      "target",
      "other-title-hit",
    ]);
    expect(result.papers[0]?.matchFields).toContain("title");
  });
});
