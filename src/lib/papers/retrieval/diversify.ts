import { cosineSimilarity } from "./embeddings";

export type RetrievalTask = "related" | "search" | "recommendations";

export interface DiversifyCandidate {
  id: string;
  relevanceScore: number;
  hubScore?: number;
  noveltyScore?: number;
  subtopics?: string[];
  vector?: number[];
}

export interface DiversifyOptions {
  task: RetrievalTask;
  limit?: number;
  lambda?: number;
  hubPenalty?: number;
  noveltyWeight?: number;
  coverageBoost?: number;
}

export interface DiversifyDefaults {
  lambda: number;
  hubPenalty: number;
  noveltyWeight: number;
  coverageBoost: number;
}

export const RETRIEVAL_DIVERSIFY_DEFAULTS: Record<
  RetrievalTask,
  DiversifyDefaults
> = {
  related: {
    lambda: 0.65,
    hubPenalty: 0.25,
    noveltyWeight: 0.05,
    coverageBoost: 0.12,
  },
  search: {
    lambda: 0.82,
    hubPenalty: 0.08,
    noveltyWeight: 0,
    coverageBoost: 0.04,
  },
  recommendations: {
    lambda: 0.55,
    hubPenalty: 0.16,
    noveltyWeight: 0.2,
    coverageBoost: 0.14,
  },
};

function maxSimilarityToSelected(
  candidate: DiversifyCandidate,
  selected: DiversifyCandidate[],
): number {
  if (!candidate.vector || selected.length === 0) return 0;
  let maxSimilarity = 0;
  for (const prior of selected) {
    if (!prior.vector || prior.vector.length !== candidate.vector.length) continue;
    maxSimilarity = Math.max(
      maxSimilarity,
      cosineSimilarity(candidate.vector, prior.vector),
    );
  }
  return maxSimilarity;
}

function unseenSubtopicCount(
  candidate: DiversifyCandidate,
  seenSubtopics: Set<string>,
): number {
  return (candidate.subtopics ?? []).filter(
    (subtopic) => !seenSubtopics.has(subtopic),
  ).length;
}

export function diversifyCandidates<T extends DiversifyCandidate>(
  candidates: T[],
  options: DiversifyOptions,
): T[] {
  const defaults = RETRIEVAL_DIVERSIFY_DEFAULTS[options.task];
  const lambda = options.lambda ?? defaults.lambda;
  const hubPenalty = options.hubPenalty ?? defaults.hubPenalty;
  const noveltyWeight = options.noveltyWeight ?? defaults.noveltyWeight;
  const coverageBoost = options.coverageBoost ?? defaults.coverageBoost;
  const limit = options.limit ?? candidates.length;

  const remaining = [...candidates];
  const selected: T[] = [];
  const seenSubtopics = new Set<string>();

  while (remaining.length > 0 && selected.length < limit) {
    remaining.sort((left, right) => {
      const leftScore =
        lambda * left.relevanceScore -
        (1 - lambda) * maxSimilarityToSelected(left, selected) -
        hubPenalty * (left.hubScore ?? 0) +
        noveltyWeight * (left.noveltyScore ?? 0) +
        coverageBoost * unseenSubtopicCount(left, seenSubtopics);
      const rightScore =
        lambda * right.relevanceScore -
        (1 - lambda) * maxSimilarityToSelected(right, selected) -
        hubPenalty * (right.hubScore ?? 0) +
        noveltyWeight * (right.noveltyScore ?? 0) +
        coverageBoost * unseenSubtopicCount(right, seenSubtopics);

      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.id.localeCompare(right.id);
    });

    const next = remaining.shift();
    if (!next) break;
    selected.push(next);
    for (const subtopic of next.subtopics ?? []) {
      seenSubtopics.add(subtopic);
    }
  }

  return selected;
}
