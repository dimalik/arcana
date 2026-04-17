import { prisma } from "../prisma";

export interface AggregatedRelation {
  peerEntityId: string;
  peerEntity: {
    id: string;
    title: string;
    year: number | null;
    authors: string | null;
  };
  relationType: string;
  maxConfidence: number;
  assertionCount: number;
  provenances: string[];
  description: string | null;
}

type RelationAggregateDb = Pick<typeof prisma, "relationAssertion">;

const PROVENANCE_PRIORITY: Record<string, number> = {
  reference_match: 0,
  citation_analysis: 1,
  discovery: 2,
  llm_semantic: 3,
  user_manual: 4,
};

export async function getAggregatedRelationsForPaper(
  paperId: string,
  entityId: string,
  userId: string,
  db: RelationAggregateDb = prisma
): Promise<AggregatedRelation[]> {
  const assertions = await db.relationAssertion.findMany({
    where: {
      OR: [
        { sourcePaperId: paperId },
        {
          targetEntityId: entityId,
          sourcePaper: { userId },
          NOT: { sourcePaperId: paperId },
        },
      ],
    },
    include: {
      targetEntity: { select: { id: true, title: true, year: true, authors: true } },
      sourceEntity: { select: { id: true, title: true, year: true, authors: true } },
    },
    orderBy: { confidence: "desc" },
  });

  const groups = new Map<string, {
    peerEntityId: string;
    peerEntity: AggregatedRelation["peerEntity"];
    relationType: string;
    confidences: number[];
    provenances: Set<string>;
    bestDescription: string | null;
    bestDescriptionPriority: number;
  }>();

  for (const assertion of assertions) {
    const isOutbound = assertion.sourceEntityId === entityId;
    const peerEntityId = isOutbound ? assertion.targetEntityId : assertion.sourceEntityId;
    const peerEntity = isOutbound ? assertion.targetEntity : assertion.sourceEntity;
    const key = `${peerEntityId}::${assertion.relationType}`;
    const priority = PROVENANCE_PRIORITY[assertion.provenance] ?? 0;

    const existing = groups.get(key);
    if (existing) {
      existing.confidences.push(assertion.confidence);
      existing.provenances.add(assertion.provenance);
      if (assertion.description && priority > existing.bestDescriptionPriority) {
        existing.bestDescription = assertion.description;
        existing.bestDescriptionPriority = priority;
      }
      continue;
    }

    groups.set(key, {
      peerEntityId,
      peerEntity,
      relationType: assertion.relationType,
      confidences: [assertion.confidence],
      provenances: new Set([assertion.provenance]),
      bestDescription: assertion.description,
      bestDescriptionPriority: priority,
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      peerEntityId: group.peerEntityId,
      peerEntity: group.peerEntity,
      relationType: group.relationType,
      maxConfidence: Math.max(...group.confidences),
      assertionCount: group.confidences.length,
      provenances: Array.from(group.provenances),
      description: group.bestDescription,
    }))
    .sort((a, b) => b.maxConfidence - a.maxConfidence);
}
