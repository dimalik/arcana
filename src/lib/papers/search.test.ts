import { describe, expect, it } from "vitest";

import { parseSearchQuery, shouldRunSemanticSearch } from "./search";

function makeLexicalSeeds(count: number) {
  return new Map(
    Array.from({ length: count }, (_, index) => [
      `paper-${index}`,
      {
        paperId: `paper-${index}`,
        lexicalMatchKinds: new Set(["title" as const]),
        authorIndexHits: 0,
        semanticScore: 0,
      },
    ]),
  );
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
});
