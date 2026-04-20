import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphRelationRow } from "../../assertions/relation-reader";

const hoisted = vi.hoisted(() => ({
  getDefaultModel: vi.fn(),
  generateStructuredObject: vi.fn(),
}));

vi.mock("../../llm/auto-process", () => ({
  getDefaultModel: hoisted.getDefaultModel,
}));

vi.mock("../../llm/provider", () => ({
  generateStructuredObject: hoisted.generateStructuredObject,
}));

vi.mock("../../llm/prompts", () => ({
  SYSTEM_PROMPTS: {
    rerankRelatedPapers: "rank related papers",
  },
}));

vi.mock("../../llm/paper-llm-context", () => ({
  PAPER_INTERACTIVE_LLM_OPERATIONS: {
    RELATED_RERANK: "paper_related_rerank",
  },
  withPaperLlmContext: (_params: unknown, fn: () => unknown) => fn(),
}));

interface MockPaperRow {
  id: string;
  userId: string;
  entityId: string;
  title: string;
  abstract: string | null;
  summary: string | null;
  authors: string;
  year: number;
  venue: string | null;
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

function createMockDb() {
  const papers = new Map<string, MockPaperRow>([
    [
      "seed",
      {
        id: "seed",
        userId: "user-1",
        entityId: "entity-seed",
        title:
          "Phi-3 Technical Report: A Highly Capable Language Model Locally on Your Phone",
        abstract:
          "A compact language model optimized for on-device and mobile inference.",
        summary: "Compact language model for local deployment.",
        authors: JSON.stringify(["Microsoft Research"]),
        year: 2024,
        venue: null,
        citationCount: 120,
        duplicateState: "ACTIVE",
        _count: { sourceRelations: 2, targetRelations: 0 },
      },
    ],
    [
      "good-a",
      {
        id: "good-a",
        userId: "user-1",
        entityId: "entity-good-a",
        title:
          "Efficient Memory Management for Large Language Model Serving with PagedAttention",
        abstract:
          "Memory management and efficient serving techniques for large language model inference.",
        summary: null,
        authors: JSON.stringify(["LLM Systems Author"]),
        year: 2023,
        venue: null,
        citationCount: 80,
        duplicateState: "ACTIVE",
        _count: { sourceRelations: 0, targetRelations: 1 },
      },
    ],
    [
      "good-b",
      {
        id: "good-b",
        userId: "user-1",
        entityId: "entity-good-b",
        title:
          "SparQ Attention: Bandwidth-Efficient LLM Inference",
        abstract:
          "Attention and inference improvements for efficient LLM serving and deployment.",
        summary: null,
        authors: JSON.stringify(["Efficient Attention Author"]),
        year: 2024,
        venue: null,
        citationCount: 65,
        duplicateState: "ACTIVE",
        _count: { sourceRelations: 0, targetRelations: 1 },
      },
    ],
    [
      "bad-c",
      {
        id: "bad-c",
        userId: "user-1",
        entityId: "entity-bad-c",
        title: "Boundary-aware Diffusion for Shadow Generation in Synthetic Scenes",
        abstract:
          "A diffusion model for synthetic image shadow generation and boundary detection.",
        summary: null,
        authors: JSON.stringify(["Vision Author"]),
        year: 2024,
        venue: null,
        citationCount: 190,
        duplicateState: "ACTIVE",
        _count: { sourceRelations: 0, targetRelations: 1 },
      },
    ],
    [
      "good-c",
      {
        id: "good-c",
        userId: "user-1",
        entityId: "entity-good-c",
        title:
          "PackInfer: Compute- and I/O-Efficient Attention for Batched LLM Inference",
        abstract:
          "Attention kernels and LLM serving optimizations for efficient batched inference.",
        summary: null,
        authors: JSON.stringify(["Serving Systems Author"]),
        year: 2024,
        venue: null,
        citationCount: 72,
        duplicateState: "ACTIVE",
        _count: { sourceRelations: 0, targetRelations: 1 },
      },
    ],
  ]);

  const representations = new Map([
    [
      "seed",
      createRepresentationRow("seed", [1, 0, 0], [
        "llm-inference",
        "on-device",
      ]),
    ],
    [
      "good-a",
      createRepresentationRow("good-a", [0.9, 0.1, 0], [
        "llm-serving",
        "memory-management",
      ]),
    ],
    [
      "good-b",
      createRepresentationRow("good-b", [0.88, 0.12, 0], [
        "efficient-attention",
        "llm-inference",
      ]),
    ],
    [
      "bad-c",
      createRepresentationRow("bad-c", [0.86, 0.14, 0], [
        "diffusion",
        "vision",
      ]),
    ],
    [
      "good-c",
      createRepresentationRow("good-c", [0.89, 0.11, 0], [
        "llm-serving",
        "efficient-attention",
      ]),
    ],
  ]);

  return {
    paper: {
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
      findMany: async () => [
        { sourcePaperId: "seed", targetPaperId: "good-a" },
        { sourcePaperId: "seed", targetPaperId: "good-b" },
      ],
    },
    relationAssertion: {
      findMany: async () => [
        {
          targetEntityId: "entity-good-a",
          evidence: [
            {
              type: "deterministic_signal:direct_citation",
              excerpt: JSON.stringify({
                rawValue: 1,
                weight: 0.08,
                contribution: 0.08,
              }),
            },
          ],
        },
        {
          targetEntityId: "entity-good-b",
          evidence: [
            {
              type: "deterministic_signal:bibliographic_coupling",
              excerpt: JSON.stringify({
                rawValue: 0.72,
                weight: 0.08,
                contribution: 0.0576,
              }),
            },
          ],
        },
        {
          targetEntityId: "entity-good-c",
          evidence: [
            {
              type: "deterministic_signal:co_citation",
              excerpt: JSON.stringify({
                rawValue: 0.61,
                weight: 0.04,
                contribution: 0.0244,
              }),
            },
          ],
        },
      ],
    },
  };
}

describe("related-ranker llm backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    hoisted.getDefaultModel.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-4o-mini",
      proxyConfig: undefined,
    });
  });

  it("uses listwise selections to reorder and prune candidates", async () => {
    hoisted.generateStructuredObject.mockResolvedValue({
      object: {
        selectedPapers: [
          {
            paperId: "good-b",
            relevanceScore: 0.95,
            rationale: "Directly about efficient LLM inference through attention changes.",
            primarySignals: ["shared-problem", "efficient-attention"],
          },
          {
            paperId: "good-a",
            relevanceScore: 0.89,
            rationale: "Targets the same LLM serving and deployment bottlenecks.",
            primarySignals: ["llm-serving", "citation-lineage"],
          },
          {
            paperId: "good-c",
            relevanceScore: 0.83,
            rationale: "Focuses on efficient attention and batched inference for LLM serving.",
            primarySignals: ["efficient-attention", "llm-serving"],
          },
        ],
        summary: "Retained the LLM inference papers and dropped the unrelated vision diffusion paper.",
      },
    });

    const { buildRelatedRerankResult } = await import("./related-ranker");

    const relationRows: GraphRelationRow[] = [
      {
        id: "rel-a",
        relatedPaper: {
          id: "good-a",
          entityId: "entity-good-a",
          title:
            "Efficient Memory Management for Large Language Model Serving with PagedAttention",
          year: 2023,
          authors: JSON.stringify(["LLM Systems Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related via LLM serving and memory-management evidence.",
        confidence: 0.58,
        isAutoGenerated: true,
      },
      {
        id: "rel-b",
        relatedPaper: {
          id: "good-b",
          entityId: "entity-good-b",
          title: "SparQ Attention: Bandwidth-Efficient LLM Inference",
          year: 2024,
          authors: JSON.stringify(["Efficient Attention Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related via efficient attention and inference evidence.",
        confidence: 0.54,
        isAutoGenerated: true,
      },
      {
        id: "rel-c",
        relatedPaper: {
          id: "good-c",
          entityId: "entity-good-c",
          title:
            "PackInfer: Compute- and I/O-Efficient Attention for Batched LLM Inference",
          year: 2024,
          authors: JSON.stringify(["Serving Systems Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related via efficient attention and serving evidence.",
        confidence: 0.55,
        isAutoGenerated: true,
      },
      {
        id: "rel-d",
        relatedPaper: {
          id: "bad-c",
          entityId: "entity-bad-c",
          title: "Boundary-aware Diffusion for Shadow Generation in Synthetic Scenes",
          year: 2024,
          authors: JSON.stringify(["Vision Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related only via broad semantic similarity.",
        confidence: 0.53,
        isAutoGenerated: true,
      },
    ];

    const result = await buildRelatedRerankResult(
      "seed",
      "user-1",
      relationRows,
      createMockDb() as never,
      { backendId: "llm_listwise_v1" },
    );

    expect(result.backend).toEqual({
      id: "llm_listwise_v1",
      family: "llm-listwise",
    });
    expect(result.rerankedRows.map((row) => row.relatedPaper.id)).toEqual([
      "good-b",
      "good-a",
      "good-c",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.paperId)).toEqual([
      "good-b",
      "good-a",
      "good-c",
    ]);
    expect(hoisted.generateStructuredObject).toHaveBeenCalledTimes(1);
  });

  it("falls back to the feature backend if listwise reranking fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.generateStructuredObject.mockRejectedValue(
      new Error("provider unavailable"),
    );

    const { buildRelatedRerankResult } = await import("./related-ranker");

    const relationRows: GraphRelationRow[] = [
      {
        id: "rel-a",
        relatedPaper: {
          id: "good-a",
          entityId: "entity-good-a",
          title:
            "Efficient Memory Management for Large Language Model Serving with PagedAttention",
          year: 2023,
          authors: JSON.stringify(["LLM Systems Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related via LLM serving and memory-management evidence.",
        confidence: 0.58,
        isAutoGenerated: true,
      },
      {
        id: "rel-b",
        relatedPaper: {
          id: "good-b",
          entityId: "entity-good-b",
          title: "SparQ Attention: Bandwidth-Efficient LLM Inference",
          year: 2024,
          authors: JSON.stringify(["Efficient Attention Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related via efficient attention and inference evidence.",
        confidence: 0.54,
        isAutoGenerated: true,
      },
      {
        id: "rel-c",
        relatedPaper: {
          id: "good-c",
          entityId: "entity-good-c",
          title:
            "PackInfer: Compute- and I/O-Efficient Attention for Batched LLM Inference",
          year: 2024,
          authors: JSON.stringify(["Serving Systems Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related via efficient attention and serving evidence.",
        confidence: 0.55,
        isAutoGenerated: true,
      },
      {
        id: "rel-d",
        relatedPaper: {
          id: "bad-c",
          entityId: "entity-bad-c",
          title: "Boundary-aware Diffusion for Shadow Generation in Synthetic Scenes",
          year: 2024,
          authors: JSON.stringify(["Vision Author"]),
          duplicateState: "ACTIVE",
        },
        relationType: "related",
        description: "Related only via broad semantic similarity.",
        confidence: 0.53,
        isAutoGenerated: true,
      },
    ];

    const result = await buildRelatedRerankResult(
      "seed",
      "user-1",
      relationRows,
      createMockDb() as never,
      { backendId: "llm_listwise_v1" },
    );

    expect(result.backend).toEqual({
      id: "feature_v1",
      family: "feature-ranker",
    });
    expect(result.rerankedRows.map((row) => row.relatedPaper.id)).toEqual([
      "good-b",
      "good-a",
      "good-c",
    ]);
    warnSpy.mockRestore();
  });
});
