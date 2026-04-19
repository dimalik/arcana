import { prisma } from "../prisma";
import { collectIdentifiers, resolveOrCreateEntity } from "../canonical/entity-service";
import { createRelationAssertion } from "./relation-assertion-service";
import { projectLegacyRelation } from "./legacy-projection";
import {
  GRAPH_RELATED_PAPER_SELECT,
  GraphRelationError,
  GraphRelatedPaperSummary,
  GraphRouteRelationRow,
  listRelationsForPaper,
  parseAggregateKey,
  toRouteRelationRow,
} from "./relation-reader";

type GraphTxDb = Pick<
  typeof prisma,
  "paper" | "paperRelation" | "relationAssertion" | "paperEntity" | "paperIdentifier" | "paperEntityCandidateLink"
>;

type GraphRootDb = GraphTxDb & Pick<typeof prisma, "$transaction">;

export const GRAPH_WRITE_PAPER_SELECT = {
  id: true,
  userId: true,
  entityId: true,
  title: true,
  authors: true,
  year: true,
  venue: true,
  abstract: true,
  doi: true,
  arxivId: true,
  semanticScholarId: true,
} as const;

export interface GraphWritePaper {
  id: string;
  userId: string | null;
  entityId: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  doi: string | null;
  arxivId: string | null;
  semanticScholarId: string | null;
}

export interface CreateManualRelationInput {
  paperId: string;
  targetPaperId: string;
  userId: string;
  relationType: string;
  description?: string | null;
}

export interface DeleteManualRelationInput {
  paperId: string;
  userId: string;
  relationId: string;
}
export {
  buildLegacyOverlayRows,
  GraphRelationError,
  listAggregatedRelationRowsForPaper,
  listLegacyVisibleRelationsForPaper,
  listRelationsForPaper,
  type GraphRelationListResult,
  type GraphRelationReadMode,
  type GraphRelationRow,
} from "./relation-reader";

export async function getPaperForGraphWrite(
  paperId: string,
  userId: string,
  db: Pick<typeof prisma, "paper"> = prisma
): Promise<GraphWritePaper | null> {
  return db.paper.findFirst({
    where: { id: paperId, userId },
    select: GRAPH_WRITE_PAPER_SELECT,
  });
}

export async function ensurePaperEntityForGraph(
  paper: GraphWritePaper,
  db: GraphTxDb = prisma
): Promise<GraphWritePaper & { entityId: string }> {
  if (paper.entityId) {
    return paper as GraphWritePaper & { entityId: string };
  }

  const identifiers = collectIdentifiers(paper, "graph_auto_heal");
  if (identifiers.length === 0) {
    throw new GraphRelationError(
      `Paper ${paper.id} cannot be linked into the graph because it has no stable identifiers`,
      409,
      "missing_identifiers"
    );
  }

  const resolved = await resolveOrCreateEntity(
    {
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      abstract: paper.abstract,
      identifiers,
      source: "graph_auto_heal",
    },
    db
  );

  if (paper.userId) {
    const duplicate = await db.paper.findFirst({
      where: {
        userId: paper.userId,
        entityId: resolved.entityId,
        NOT: { id: paper.id },
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new GraphRelationError(
        `Paper ${paper.id} collides with existing library paper ${duplicate.id} for entity ${resolved.entityId}`,
        409,
        "duplicate_entity_binding"
      );
    }
  }

  try {
    const updated = await db.paper.update({
      where: { id: paper.id },
      data: { entityId: resolved.entityId },
      select: GRAPH_WRITE_PAPER_SELECT,
    });

    return updated as GraphWritePaper & { entityId: string };
  } catch {
    throw new GraphRelationError(
      `Paper ${paper.id} could not be linked to entity ${resolved.entityId}`,
      409,
      "entity_binding_failed"
    );
  }
}

export async function createManualRelation(
  input: CreateManualRelationInput,
  db: GraphRootDb = prisma
): Promise<GraphRouteRelationRow> {
  return db.$transaction(async (tx) => {
    const [sourcePaper, targetPaper] = await Promise.all([
      getPaperForGraphWrite(input.paperId, input.userId, tx),
      getPaperForGraphWrite(input.targetPaperId, input.userId, tx),
    ]);

    if (!sourcePaper || !targetPaper) {
      throw new GraphRelationError(
        "One or both papers not found",
        404,
        "paper_not_found"
      );
    }

    if (sourcePaper.id === targetPaper.id) {
      throw new GraphRelationError(
        "Cannot create a relation to the same paper",
        400,
        "self_relation"
      );
    }

    const linkedSource = await ensurePaperEntityForGraph(sourcePaper, tx);
    const linkedTarget = await ensurePaperEntityForGraph(targetPaper, tx);

    await createRelationAssertion(
      {
        sourceEntityId: linkedSource.entityId,
        targetEntityId: linkedTarget.entityId,
        sourcePaperId: linkedSource.id,
        relationType: input.relationType,
        description: input.description ?? null,
        confidence: 1.0,
        provenance: "user_manual",
        createdByUserId: input.userId,
      },
      tx
    );

    await projectLegacyRelation(
      linkedSource.id,
      linkedTarget.id,
      linkedSource.entityId,
      linkedTarget.entityId,
      tx
    );

    const projected = await tx.paperRelation.findUnique({
      where: {
        sourcePaperId_targetPaperId: {
          sourcePaperId: linkedSource.id,
          targetPaperId: linkedTarget.id,
        },
      },
      include: {
        targetPaper: {
          select: GRAPH_RELATED_PAPER_SELECT,
        },
      },
    });

    if (!projected) {
      throw new GraphRelationError(
        "Manual relation projection did not materialize",
        500,
        "projection_missing"
      );
    }

    return toRouteRelationRow({
      id: projected.id,
      relatedPaper: projected.targetPaper as GraphRelatedPaperSummary,
      relationType: projected.relationType,
      description: projected.description,
      confidence: projected.confidence,
      isAutoGenerated: projected.isAutoGenerated,
    });
  });
}

async function recomputeProjectedRelationsForPeerEntity(
  sourcePaper: GraphWritePaper & { entityId: string },
  peerEntityId: string,
  userId: string,
  db: GraphTxDb
) {
  const peerPapers = await db.paper.findMany({
    where: { entityId: peerEntityId, userId },
    select: GRAPH_WRITE_PAPER_SELECT,
  });

  for (const peerPaper of peerPapers as GraphWritePaper[]) {
    if (peerPaper.id === sourcePaper.id || !peerPaper.entityId) continue;

    await projectLegacyRelation(
      sourcePaper.id,
      peerPaper.id,
      sourcePaper.entityId,
      peerPaper.entityId,
      db
    );
    await projectLegacyRelation(
      peerPaper.id,
      sourcePaper.id,
      peerPaper.entityId,
      sourcePaper.entityId,
      db
    );
  }
}

export async function deleteManualRelation(
  input: DeleteManualRelationInput,
  db: GraphRootDb = prisma
): Promise<void> {
  return db.$transaction(async (tx) => {
    const sourcePaper = await getPaperForGraphWrite(input.paperId, input.userId, tx);
    if (!sourcePaper) {
      throw new GraphRelationError("Paper not found", 404, "paper_not_found");
    }

    const aggregateKey = parseAggregateKey(input.relationId);
    if (aggregateKey) {
      const linkedSource = await ensurePaperEntityForGraph(sourcePaper, tx);
      const deleted = await tx.relationAssertion.deleteMany({
        where: {
          relationType: aggregateKey.relationType,
          OR: [
            { sourcePaperId: linkedSource.id, targetEntityId: aggregateKey.peerEntityId },
            {
              sourceEntityId: aggregateKey.peerEntityId,
              targetEntityId: linkedSource.entityId,
              sourcePaper: { userId: input.userId },
            },
          ],
        },
      });

      if (deleted.count === 0) {
        throw new GraphRelationError("No assertions found", 404, "assertions_not_found");
      }

      await recomputeProjectedRelationsForPeerEntity(
        linkedSource,
        aggregateKey.peerEntityId,
        input.userId,
        tx
      );
      return;
    }

    const relation = await tx.paperRelation.findUnique({
      where: { id: input.relationId },
      include: {
        sourcePaper: { select: GRAPH_WRITE_PAPER_SELECT },
        targetPaper: { select: GRAPH_WRITE_PAPER_SELECT },
      },
    });

    if (!relation) {
      throw new GraphRelationError("Relation not found", 404, "relation_not_found");
    }

    const belongsToUser =
      (relation.sourcePaperId === input.paperId && relation.sourcePaper?.userId === input.userId) ||
      (relation.targetPaperId === input.paperId && relation.targetPaper?.userId === input.userId);

    if (!belongsToUser) {
      throw new GraphRelationError(
        "Relation does not belong to this paper",
        403,
        "relation_forbidden"
      );
    }

    const currentRows = await listRelationsForPaper(input.paperId, input.userId, tx);
    const isCurrentOverlayRow = currentRows.overlayRows.some(
      (row) => row.id === input.relationId
    );

    if (isCurrentOverlayRow) {
      await tx.paperRelation.delete({ where: { id: input.relationId } });
      return;
    }

    const linkedSource = await ensurePaperEntityForGraph(
      relation.sourcePaper as GraphWritePaper,
      tx
    );
    const linkedTarget = await ensurePaperEntityForGraph(
      relation.targetPaper as GraphWritePaper,
      tx
    );

    const deleted = await tx.relationAssertion.deleteMany({
      where: {
        sourcePaperId: linkedSource.id,
        targetEntityId: linkedTarget.entityId,
        relationType: relation.relationType,
      },
    });

    if (deleted.count === 0) {
      throw new GraphRelationError(
        "Relation is no longer backed by assertions",
        404,
        "relation_not_asserted"
      );
    }

    await projectLegacyRelation(
      linkedSource.id,
      linkedTarget.id,
      linkedSource.entityId,
      linkedTarget.entityId,
      tx
    );
  });
}

export async function clearAutoGeneratedRelationsForPaper(
  paperId: string,
  db: GraphTxDb = prisma
): Promise<void> {
  await db.relationAssertion.deleteMany({
    where: {
      sourcePaperId: paperId,
      provenance: { not: "user_manual" },
    },
  });

  await db.paperRelation.deleteMany({
    where: {
      isAutoGenerated: true,
      OR: [{ sourcePaperId: paperId }, { targetPaperId: paperId }],
    },
  });
}
