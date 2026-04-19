export const PROVENANCE_PRIORITY = {
  reference_match: 0,
  citation_analysis: 1,
  discovery: 2,
  deterministic_relatedness: 3,
  llm_semantic: 4,
  user_manual: 5,
} as const;

export type RelationProvenance = keyof typeof PROVENANCE_PRIORITY | string;

export interface PrioritizedRelationAssertionLike {
  provenance: RelationProvenance;
  confidence: number;
}

export function getRelationProvenancePriority(provenance: RelationProvenance): number {
  return PROVENANCE_PRIORITY[provenance as keyof typeof PROVENANCE_PRIORITY] ?? 0;
}

export function comparePrioritizedRelationAssertions<
  T extends PrioritizedRelationAssertionLike,
>(best: T, current: T): T {
  const bestPriority = getRelationProvenancePriority(best.provenance);
  const currentPriority = getRelationProvenancePriority(current.provenance);

  if (currentPriority > bestPriority) return current;
  if (currentPriority === bestPriority && current.confidence > best.confidence) {
    return current;
  }

  return best;
}
