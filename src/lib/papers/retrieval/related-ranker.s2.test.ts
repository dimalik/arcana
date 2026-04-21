import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getS2Recommendations: vi.fn(),
  searchByTitle: vi.fn(),
}));

vi.mock("../../import/semantic-scholar", () => ({
  getS2Recommendations: hoisted.getS2Recommendations,
  searchByTitle: hoisted.searchByTitle,
}));

interface MockPaperRow {
  id: string;
  userId: string;
  entityId: string | null;
  title: string;
  abstract: string | null;
  summary: string | null;
  authors: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  citationCount: number;
  duplicateState: string;
  _count: {
    sourceRelations: number;
    targetRelations: number;
  };
}

function createRepresentationRow(
  paperId: string,
  vector: number[],
  tagNames: string[] = [],
) {
  return {
    paperId,
    representationKind: "shared_raw_features_v1",
    encoderVersion: "feature_hash_256_v1",
    sourceFingerprint: `fingerprint-${paperId}`,
    dimensions: vector.length,
    featureText: tagNames.join(" "),
    vectorJson: JSON.stringify(vector),
    metadataJson: JSON.stringify({
      title: paperId,
      authorNames: [],
      tagNames,
      claimCount: 0,
      sections: ["title", "abstract"],
    }),
  };
}

describe("related-ranker semantic scholar expansion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.searchByTitle.mockResolvedValue(null);
  });

  it("recovers a locally stored paper from semantic scholar recommendations after resolving the seed title", async () => {
    hoisted.searchByTitle.mockResolvedValue({
      semanticScholarId: "s2:seed-paper",
      title:
        "Reward Shaping Signals for Alignment in Reinforcement Learning Agents",
      abstract: null,
      authors: ["Seed Author"],
      year: 2025,
      venue: null,
      doi: null,
      arxivId: "2501.00001",
      openReviewId: null,
      externalUrl: "https://arxiv.org/abs/2501.00001",
      citationCount: 2,
      openAccessPdfUrl: null,
      source: "s2",
    });
    hoisted.getS2Recommendations.mockResolvedValue([
      {
        semanticScholarId: "s2:assistant-reward-agent",
        title:
          "Reward Shaping for Reinforcement Learning with An Assistant Reward Agent",
        abstract:
          "Assistant reward modeling and reward shaping for reinforcement learning.",
        authors: ["Exact Match Author"],
        year: 2024,
        venue: null,
        doi: "10.48550/arXiv.2502.12345",
        arxivId: "2502.12345",
        openReviewId: null,
        externalUrl: "https://arxiv.org/abs/2502.12345",
        citationCount: 3,
        openAccessPdfUrl: null,
        source: "s2",
      },
    ]);

    const { buildRelatedRerankResult } = await import("./related-ranker");

    const papers = new Map<string, MockPaperRow>([
      [
        "seed",
        {
          id: "seed",
          userId: "user-1",
          entityId: "entity-seed",
          title:
            "Reward Shaping Signals for Alignment in Reinforcement Learning Agents",
          abstract:
            "We study reward shaping, assistant rewards, and reinforcement learning credit assignment.",
          summary: null,
          authors: JSON.stringify(["Seed Author"]),
          year: 2025,
          venue: null,
          doi: null,
          arxivId: null,
          citationCount: 2,
          duplicateState: "ACTIVE",
          _count: {
            sourceRelations: 0,
            targetRelations: 0,
          },
        },
      ],
      [
        "exact",
        {
          id: "exact",
          userId: "user-1",
          entityId: "entity-exact",
          title:
            "Reward Shaping for Reinforcement Learning with An Assistant Reward Agent",
          abstract:
            "Assistant reward modeling and reward shaping for reinforcement learning agents.",
          summary: null,
          authors: JSON.stringify(["Exact Match Author"]),
          year: 2024,
          venue: null,
          doi: "10.48550/arXiv.2502.12345",
          arxivId: "2502.12345",
          citationCount: 6,
          duplicateState: "ACTIVE",
          _count: {
            sourceRelations: 0,
            targetRelations: 0,
          },
        },
      ],
    ]);

    const representations = new Map([
      [
        "seed",
        createRepresentationRow("seed", [1, 0, 0], [
          "reward shaping",
          "reinforcement learning",
        ]),
      ],
      [
        "exact",
        createRepresentationRow("exact", [0.72, 0.28, 0], [
          "assistant reward",
          "reinforcement learning",
        ]),
      ],
    ]);

    const db = {
      paper: {
        findFirst: async ({
          where,
        }: {
          where: { id?: string; userId?: string };
        }) =>
          Array.from(papers.values()).find(
            (paper) =>
              (where.id ? paper.id === where.id : true) &&
              (where.userId ? paper.userId === where.userId : true),
          ) ?? null,
        findUnique: async ({ where }: { where: { id: string } }) =>
          papers.get(where.id) ?? null,
        findMany: async ({
          where,
          take,
        }: {
          where: {
            id?: { in?: string[]; not?: string; notIn?: string[] };
            userId?: string;
            duplicateState?: string;
            OR?: Array<
              | { doi: { in: string[] } }
              | { arxivId: { in: string[] } }
              | { title: { contains: string } }
              | { abstract: { contains: string } }
              | { summary: { contains: string } }
              | { tags: { some: { tag: { name: { contains: string } } } } }
            >;
            representations?: unknown;
          };
          take?: number;
        }) => {
          const allPapers = Array.from(papers.values());
          if (where.id?.in) {
            return allPapers.filter((paper) => where.id?.in?.includes(paper.id));
          }

          return allPapers
            .filter((paper) => (where.userId ? paper.userId === where.userId : true))
            .filter((paper) =>
              where.duplicateState ? paper.duplicateState === where.duplicateState : true,
            )
            .filter((paper) => (where.id?.not ? paper.id !== where.id.not : true))
            .filter((paper) =>
              where.id?.notIn ? !where.id.notIn.includes(paper.id) : true,
            )
            .filter((paper) => {
              if (where.OR?.length) {
                return where.OR.some((clause) => {
                  if ("doi" in clause) {
                    return clause.doi.in.includes(paper.doi ?? "");
                  }
                  if ("arxivId" in clause) {
                    return clause.arxivId.in.includes(paper.arxivId ?? "");
                  }
                  if ("title" in clause) {
                    return paper.title
                      .toLowerCase()
                      .includes(clause.title.contains.toLowerCase());
                  }
                  if ("abstract" in clause) {
                    return (paper.abstract ?? "")
                      .toLowerCase()
                      .includes(clause.abstract.contains.toLowerCase());
                  }
                  if ("summary" in clause) {
                    return (paper.summary ?? "")
                      .toLowerCase()
                      .includes(clause.summary.contains.toLowerCase());
                  }
                  return false;
                });
              }
              if (where.representations) {
                return representations.has(paper.id);
              }
              return true;
            })
            .map((paper) => ({
              ...paper,
              representations: representations.has(paper.id)
                ? [representations.get(paper.id)]
                : [],
            }))
            .slice(0, take ?? allPapers.length);
        },
      },
      paperRepresentation: {
        findUnique: async ({
          where,
        }: {
          where: { paperId_representationKind: { paperId: string } };
        }) => representations.get(where.paperId_representationKind.paperId) ?? null,
        findMany: async ({
          where,
        }: {
          where: { paperId?: { in?: string[] } };
        }) =>
          Array.from(representations.values()).filter((row) =>
            where.paperId?.in ? where.paperId.in.includes(row.paperId) : true,
          ),
        upsert: async () => {
          throw new Error("upsert should not be called in this test");
        },
      },
      paperRelation: {
        findMany: async () => [],
      },
      relationAssertion: {
        findMany: async () => [],
      },
    };

    const result = await buildRelatedRerankResult(
      "seed",
      "user-1",
      [],
      db as never,
    );

    expect(hoisted.getS2Recommendations).toHaveBeenCalledWith(
      ["ArXiv:2501.00001"],
      12,
    );
    expect(hoisted.searchByTitle).toHaveBeenCalledWith(
      "Reward Shaping Signals for Alignment in Reinforcement Learning Agents",
      2025,
    );
    expect(result.rerankedRows.map((row) => row.relatedPaper.id)).toContain("exact");
  });
});
