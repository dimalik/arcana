import { describe, expect, it } from "vitest";

import { prisma } from "../../prisma";
import { getAggregatedRelationsForPaper } from "../relation-aggregate";

describe("Phase 3 parity", () => {
  it("every linked PaperRelation has an assertion with matching sourcePaperId, target entity, and relationType", async () => {
    const relations = await prisma.paperRelation.findMany({
      include: {
        sourcePaper: { select: { entityId: true } },
        targetPaper: { select: { entityId: true } },
      },
    });

    const failures: string[] = [];

    for (const relation of relations) {
      if (!relation.sourcePaper.entityId || !relation.targetPaper.entityId) continue;

      const matchingAssertion = await prisma.relationAssertion.findFirst({
        where: {
          sourcePaperId: relation.sourcePaperId,
          targetEntityId: relation.targetPaper.entityId,
          relationType: relation.relationType,
        },
        select: { id: true },
      });

      if (!matchingAssertion) {
        failures.push(
          `${relation.id}: ${relation.relationType} from ${relation.sourcePaperId} -> ${relation.targetPaper.entityId}`
        );
      }
    }

    expect(failures, failures.slice(0, 10).join("\n")).toHaveLength(0);
  });

  it("assertions preserve description from linked legacy PaperRelation rows", async () => {
    const relations = await prisma.paperRelation.findMany({
      where: { description: { not: null } },
      include: {
        sourcePaper: { select: { entityId: true } },
        targetPaper: { select: { entityId: true } },
      },
    });

    const mismatches: string[] = [];

    for (const relation of relations) {
      if (!relation.sourcePaper.entityId || !relation.targetPaper.entityId) continue;

      const assertion = await prisma.relationAssertion.findFirst({
        where: {
          sourcePaperId: relation.sourcePaperId,
          targetEntityId: relation.targetPaper.entityId,
          relationType: relation.relationType,
        },
        select: { description: true },
      });

      if (assertion && assertion.description !== relation.description) {
        mismatches.push(`${relation.id}: "${relation.description}" != "${assertion.description}"`);
      }
    }

    expect(mismatches, mismatches.slice(0, 10).join("\n")).toHaveLength(0);
  });

  it("aggregated relations cover inbound linked legacy relations", async () => {
    const papers = await prisma.paper.findMany({
      where: {
        userId: { not: null },
        entityId: { not: null },
        targetRelations: { some: {} },
      },
      select: {
        id: true,
        userId: true,
        entityId: true,
      },
    });

    for (const paper of papers) {
      const inboundRelations = await prisma.paperRelation.findMany({
        where: { targetPaperId: paper.id },
        include: {
          sourcePaper: { select: { entityId: true } },
        },
      });

      const aggregated = await getAggregatedRelationsForPaper(
        paper.id,
        paper.entityId!,
        paper.userId!
      );

      for (const legacyRelation of inboundRelations) {
        if (!legacyRelation.sourcePaper.entityId) continue;

        const matchingAggregate = aggregated.find(
          (relation) =>
            relation.peerEntityId === legacyRelation.sourcePaper.entityId &&
            relation.relationType === legacyRelation.relationType
        );

        expect(
          matchingAggregate,
          `Paper ${paper.id}: missing inbound ${legacyRelation.relationType} from ${legacyRelation.sourcePaper.entityId}`
        ).toBeDefined();
      }
    }
  });

  it("aggregated relations cover outbound linked legacy relations", async () => {
    const papers = await prisma.paper.findMany({
      where: {
        userId: { not: null },
        entityId: { not: null },
        sourceRelations: { some: {} },
      },
      select: {
        id: true,
        userId: true,
        entityId: true,
      },
    });

    for (const paper of papers) {
      const outboundRelations = await prisma.paperRelation.findMany({
        where: { sourcePaperId: paper.id },
        include: {
          targetPaper: { select: { entityId: true } },
        },
      });

      const aggregated = await getAggregatedRelationsForPaper(
        paper.id,
        paper.entityId!,
        paper.userId!
      );

      for (const legacyRelation of outboundRelations) {
        if (!legacyRelation.targetPaper.entityId) continue;

        const matchingAggregate = aggregated.find(
          (relation) =>
            relation.peerEntityId === legacyRelation.targetPaper.entityId &&
            relation.relationType === legacyRelation.relationType
        );

        expect(
          matchingAggregate,
          `Paper ${paper.id}: missing outbound ${legacyRelation.relationType} to ${legacyRelation.targetPaper.entityId}`
        ).toBeDefined();
      }
    }
  });
});
