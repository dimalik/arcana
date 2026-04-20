import { prisma } from "../../prisma";
import { paperVisibilityWhere } from "../visibility";

import { searchSharedPaperRepresentationsByPaper } from "./embeddings";
import type { RetrievalCandidate } from "./candidate-generation";

type PersonalizedPageRankDb = Pick<
  typeof prisma,
  "paper" | "paperRelation" | "paperRepresentation"
>;

export interface PersonalizedPageRankRelatedCandidateOptions {
  paperId: string;
  userId: string;
  limit?: number;
  restartProbability?: number;
  maxIterations?: number;
  tolerance?: number;
  directCitationWeight?: number;
  reverseCitationWeight?: number;
  semanticBridgeLimit?: number;
  semanticBridgeWeight?: number;
  semanticScoreFloor?: number;
}

export interface PersonalizedPageRankDiagnostics {
  nodeCount: number;
  edgeCount: number;
  iterations: number;
  converged: boolean;
  l1Delta: number;
  semanticBridgeCount: number;
}

export interface PersonalizedPageRankRelatedCandidateResult {
  candidates: RetrievalCandidate[];
  diagnostics: PersonalizedPageRankDiagnostics;
}

interface WeightedNeighbor {
  id: string;
  weight: number;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_RESTART_PROBABILITY = 0.2;
const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_DIRECT_CITATION_WEIGHT = 1;
const DEFAULT_REVERSE_CITATION_WEIGHT = 1;
const DEFAULT_SEMANTIC_BRIDGE_LIMIT = 80;
const DEFAULT_SEMANTIC_BRIDGE_WEIGHT = 0.35;
const DEFAULT_SEMANTIC_SCORE_FLOOR = 0.18;

function normalizeNeighborWeights(
  adjacency: Map<string, WeightedNeighbor[]>,
): Map<string, WeightedNeighbor[]> {
  const normalized = new Map<string, WeightedNeighbor[]>();

  for (const [nodeId, neighbors] of Array.from(adjacency.entries())) {
    const total = neighbors.reduce(
      (sum: number, neighbor: WeightedNeighbor) => sum + neighbor.weight,
      0,
    );
    if (total <= 0) continue;
    normalized.set(
      nodeId,
      neighbors.map((neighbor: WeightedNeighbor) => ({
        id: neighbor.id,
        weight: neighbor.weight / total,
      })),
    );
  }

  return normalized;
}

function addEdge(
  adjacency: Map<string, WeightedNeighbor[]>,
  sourceId: string,
  targetId: string,
  weight: number,
): void {
  if (!sourceId || !targetId || sourceId === targetId || weight <= 0) return;
  const current = adjacency.get(sourceId) ?? [];
  current.push({ id: targetId, weight });
  adjacency.set(sourceId, current);
}

async function loadVisiblePaperIndex(
  userId: string,
  db: PersonalizedPageRankDb,
): Promise<Map<string, { title: string }>> {
  const rows = await db.paper.findMany({
    where: paperVisibilityWhere(userId),
    select: {
      id: true,
      title: true,
    },
  });

  return new Map(rows.map((row) => [row.id, { title: row.title }]));
}

async function loadCitationAdjacency(
  userId: string,
  visiblePaperIds: Set<string>,
  db: PersonalizedPageRankDb,
  {
    directCitationWeight,
    reverseCitationWeight,
  }: {
    directCitationWeight: number;
    reverseCitationWeight: number;
  },
): Promise<{ adjacency: Map<string, WeightedNeighbor[]>; edgeCount: number }> {
  const rows = await db.paperRelation.findMany({
    where: {
      relationType: "cites",
      sourcePaper: paperVisibilityWhere(userId),
      targetPaper: paperVisibilityWhere(userId),
    },
    select: {
      sourcePaperId: true,
      targetPaperId: true,
    },
  });

  const adjacency = new Map<string, WeightedNeighbor[]>();
  let edgeCount = 0;

  for (const row of rows) {
    if (
      !visiblePaperIds.has(row.sourcePaperId) ||
      !visiblePaperIds.has(row.targetPaperId)
    ) {
      continue;
    }

    addEdge(adjacency, row.sourcePaperId, row.targetPaperId, directCitationWeight);
    addEdge(adjacency, row.targetPaperId, row.sourcePaperId, reverseCitationWeight);
    edgeCount += 2;
  }

  return { adjacency, edgeCount };
}

async function loadSemanticBridgeEdges(
  options: {
    paperId: string;
    userId: string;
    semanticBridgeLimit: number;
    semanticBridgeWeight: number;
    semanticScoreFloor: number;
  },
  db: PersonalizedPageRankDb,
): Promise<{
  bridges: Array<{ paperId: string; title: string; score: number }>;
  adjacency: Map<string, WeightedNeighbor[]>;
}> {
  const matches = await searchSharedPaperRepresentationsByPaper(
    {
      userId: options.userId,
      paperId: options.paperId,
      limit: options.semanticBridgeLimit,
    },
    db,
  );

  const filtered = matches.filter(
    (match) => match.score >= options.semanticScoreFloor,
  );
  const adjacency = new Map<string, WeightedNeighbor[]>();

  for (const match of filtered) {
    const weight = Number(
      (options.semanticBridgeWeight * match.score).toFixed(6),
    );
    addEdge(adjacency, options.paperId, match.paperId, weight);
    addEdge(adjacency, match.paperId, options.paperId, weight);
  }

  return {
    bridges: filtered.map((match) => ({
      paperId: match.paperId,
      title: match.title,
      score: match.score,
    })),
    adjacency,
  };
}

function mergeAdjacencyMaps(
  left: Map<string, WeightedNeighbor[]>,
  right: Map<string, WeightedNeighbor[]>,
): Map<string, WeightedNeighbor[]> {
  const merged = new Map<string, WeightedNeighbor[]>();

  for (const [nodeId, neighbors] of Array.from(left.entries())) {
    merged.set(nodeId, [...neighbors]);
  }

  for (const [nodeId, neighbors] of Array.from(right.entries())) {
    const current = merged.get(nodeId) ?? [];
    current.push(...neighbors);
    merged.set(nodeId, current);
  }

  return merged;
}

function runPersonalizedPageRank(
  nodeIds: string[],
  adjacency: Map<string, WeightedNeighbor[]>,
  seedPaperId: string,
  {
    restartProbability,
    maxIterations,
    tolerance,
  }: {
    restartProbability: number;
    maxIterations: number;
    tolerance: number;
  },
): {
  scores: Map<string, number>;
  iterations: number;
  converged: boolean;
  l1Delta: number;
} {
  const scores = new Map<string, number>(nodeIds.map((nodeId) => [nodeId, 0]));
  scores.set(seedPaperId, 1);

  let converged = false;
  let l1Delta = 0;
  let iterations = 0;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const next = new Map<string, number>(nodeIds.map((nodeId) => [nodeId, 0]));
    next.set(seedPaperId, restartProbability);

    let danglingMass = 0;
    for (const nodeId of nodeIds) {
      const score = scores.get(nodeId) ?? 0;
      if (score <= 0) continue;
      const neighbors = adjacency.get(nodeId);

      if (!neighbors || neighbors.length === 0) {
        danglingMass += score;
        continue;
      }

      for (const neighbor of neighbors) {
        next.set(
          neighbor.id,
          (next.get(neighbor.id) ?? 0) +
            (1 - restartProbability) * score * neighbor.weight,
        );
      }
    }

    if (danglingMass > 0) {
      next.set(
        seedPaperId,
        (next.get(seedPaperId) ?? 0) +
          (1 - restartProbability) * danglingMass,
      );
    }

    l1Delta = 0;
    for (const nodeId of nodeIds) {
      l1Delta += Math.abs((next.get(nodeId) ?? 0) - (scores.get(nodeId) ?? 0));
    }

    for (const [nodeId, value] of Array.from(next.entries())) {
      scores.set(nodeId, value);
    }

    iterations = iteration + 1;
    if (l1Delta <= tolerance) {
      converged = true;
      break;
    }
  }

  return {
    scores,
    iterations,
    converged,
    l1Delta: Number(l1Delta.toFixed(8)),
  };
}

export async function generatePersonalizedPageRankRelatedCandidates(
  options: PersonalizedPageRankRelatedCandidateOptions,
  db: PersonalizedPageRankDb = prisma,
): Promise<PersonalizedPageRankRelatedCandidateResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const restartProbability =
    options.restartProbability ?? DEFAULT_RESTART_PROBABILITY;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const directCitationWeight =
    options.directCitationWeight ?? DEFAULT_DIRECT_CITATION_WEIGHT;
  const reverseCitationWeight =
    options.reverseCitationWeight ?? DEFAULT_REVERSE_CITATION_WEIGHT;
  const semanticBridgeLimit =
    options.semanticBridgeLimit ?? DEFAULT_SEMANTIC_BRIDGE_LIMIT;
  const semanticBridgeWeight =
    options.semanticBridgeWeight ?? DEFAULT_SEMANTIC_BRIDGE_WEIGHT;
  const semanticScoreFloor =
    options.semanticScoreFloor ?? DEFAULT_SEMANTIC_SCORE_FLOOR;

  const visiblePaperIndex = await loadVisiblePaperIndex(options.userId, db);
  if (!visiblePaperIndex.has(options.paperId)) {
    return {
      candidates: [],
      diagnostics: {
        nodeCount: 0,
        edgeCount: 0,
        iterations: 0,
        converged: true,
        l1Delta: 0,
        semanticBridgeCount: 0,
      },
    };
  }

  const visiblePaperIds = new Set(visiblePaperIndex.keys());
  const citationGraph = await loadCitationAdjacency(
    options.userId,
    visiblePaperIds,
    db,
    {
      directCitationWeight,
      reverseCitationWeight,
    },
  );
  const semanticBridges = await loadSemanticBridgeEdges(
    {
      paperId: options.paperId,
      userId: options.userId,
      semanticBridgeLimit,
      semanticBridgeWeight,
      semanticScoreFloor,
    },
    db,
  );
  const adjacency = normalizeNeighborWeights(
    mergeAdjacencyMaps(citationGraph.adjacency, semanticBridges.adjacency),
  );
  const nodeIds = Array.from(
    new Set([
      options.paperId,
      ...Array.from(adjacency.keys()),
      ...Array.from(adjacency.values()).flatMap((neighbors) =>
        neighbors.map((neighbor) => neighbor.id),
      ),
    ]),
  );

  const pageRank = runPersonalizedPageRank(nodeIds, adjacency, options.paperId, {
    restartProbability,
    maxIterations,
    tolerance,
  });
  const semanticBridgeMap = new Map(
    semanticBridges.bridges.map((bridge) => [bridge.paperId, bridge.score]),
  );

  const candidates = Array.from(pageRank.scores.entries())
    .filter(([paperId]) => paperId !== options.paperId)
    .filter(([, score]) => score > 0)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([paperId, score]) => ({
      paperId,
      title: visiblePaperIndex.get(paperId)?.title ?? paperId,
      source: "graph" as const,
      score: Number(score.toFixed(6)),
      relationType: "ppr_related",
      description:
        "Recovered via personalized PageRank over the local citation graph with semantic bridge edges from the seed paper.",
      signals: {
        algorithm: "personalized_pagerank_v1",
        pagerankScore: Number(score.toFixed(6)),
        semanticBridgeScore: semanticBridgeMap.get(paperId) ?? null,
      },
    }));

  return {
    candidates,
    diagnostics: {
      nodeCount: nodeIds.length,
      edgeCount:
        Array.from(adjacency.values()).reduce(
          (sum, neighbors) => sum + neighbors.length,
          0,
        ),
      iterations: pageRank.iterations,
      converged: pageRank.converged,
      l1Delta: pageRank.l1Delta,
      semanticBridgeCount: semanticBridges.bridges.length,
    },
  };
}
