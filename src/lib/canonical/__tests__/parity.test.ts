import { describe, expect, it } from "vitest";

import { prisma } from "../../prisma";
import { normalizeIdentifier } from "../normalize";

describe("Phase 1 parity", () => {
  it("every user-visible canonical work with a DOI has entity representation", async () => {
    const papersWithDoi = await prisma.paper.findMany({
      where: {
        userId: { not: null },
        doi: { not: null },
      },
      select: {
        userId: true,
        doi: true,
        entityId: true,
      },
    });

    const groups = new Map<string, boolean>();
    for (const paper of papersWithDoi) {
      if (!paper.userId || !paper.doi) continue;
      const key = `${paper.userId}::${normalizeIdentifier("doi", paper.doi)}`;
      groups.set(key, (groups.get(key) ?? false) || paper.entityId !== null);
    }

    const unlinkedGroups = Array.from(groups.entries())
      .filter(([, hasEntity]) => !hasEntity)
      .map(([key]) => key);

    expect(
      unlinkedGroups,
      `${unlinkedGroups.length} (user, DOI) groups have no linked Paper:\n${unlinkedGroups.slice(0, 10).join("\n")}`
    ).toHaveLength(0);
  });

  it("every user-visible canonical work with an arXiv ID has entity representation", async () => {
    const papersWithArxiv = await prisma.paper.findMany({
      where: {
        userId: { not: null },
        arxivId: { not: null },
      },
      select: {
        userId: true,
        arxivId: true,
        entityId: true,
      },
    });

    const groups = new Map<string, boolean>();
    for (const paper of papersWithArxiv) {
      if (!paper.userId || !paper.arxivId) continue;
      const key = `${paper.userId}::${normalizeIdentifier("arxiv", paper.arxivId)}`;
      groups.set(key, (groups.get(key) ?? false) || paper.entityId !== null);
    }

    const unlinkedGroups = Array.from(groups.entries())
      .filter(([, hasEntity]) => !hasEntity)
      .map(([key]) => key);

    expect(
      unlinkedGroups,
      `${unlinkedGroups.length} (user, arXiv) groups have no linked Paper:\n${unlinkedGroups.slice(0, 10).join("\n")}`
    ).toHaveLength(0);
  });

  it("every pre-backfill DiscoveryProposal with identifiers has an entityId", async () => {
    const cutoffEnv = process.env.BACKFILL_CUTOFF;
    expect(
      cutoffEnv,
      "BACKFILL_CUTOFF env var is required. Set it to the ISO timestamp noted before running the backfill."
    ).toBeDefined();

    const cutoff = new Date(cutoffEnv!);
    expect(cutoff.getTime(), "BACKFILL_CUTOFF is not a valid ISO timestamp").not.toBeNaN();

    const unlinked = await prisma.discoveryProposal.count({
      where: {
        createdAt: { lt: cutoff },
        entityId: null,
        OR: [
          { doi: { not: null } },
          { arxivId: { not: null } },
          { semanticScholarId: { not: null } },
        ],
      },
    });

    expect(
      unlinked,
      `${unlinked} pre-backfill proposals with DOI/arXiv/S2 identifiers are still unlinked`
    ).toBe(0);
  });

  it("no PaperEntity merge pointer targets a missing entity", async () => {
    const mergedEntities = await prisma.paperEntity.findMany({
      where: { mergedIntoEntityId: { not: null } },
      select: { id: true, mergedIntoEntityId: true },
    });

    const dangling: string[] = [];
    for (const entity of mergedEntities) {
      const target = await prisma.paperEntity.findUnique({
        where: { id: entity.mergedIntoEntityId! },
        select: { id: true },
      });
      if (!target) {
        dangling.push(`${entity.id} -> ${entity.mergedIntoEntityId}`);
      }
    }

    expect(dangling, dangling.join("\n")).toHaveLength(0);
  });

  it("no user has two Papers with the same entityId", async () => {
    const papers = await prisma.paper.findMany({
      where: {
        userId: { not: null },
        entityId: { not: null },
      },
      select: {
        id: true,
        userId: true,
        entityId: true,
      },
    });

    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const paper of papers) {
      const key = `${paper.userId}::${paper.entityId}`;
      const existing = seen.get(key);
      if (existing) {
        duplicates.push(`User ${paper.userId} has papers ${existing} and ${paper.id} on entity ${paper.entityId}`);
        continue;
      }
      seen.set(key, paper.id);
    }

    expect(duplicates, duplicates.join("\n")).toHaveLength(0);
  });

  it("exact DOI duplicates collapse to one PaperEntity", async () => {
    const papers = await prisma.paper.findMany({
      where: {
        doi: { not: null },
        entityId: { not: null },
      },
      select: {
        doi: true,
        entityId: true,
      },
    });

    const doiToEntities = new Map<string, Set<string>>();
    for (const paper of papers) {
      if (!paper.doi || !paper.entityId) continue;
      const key = normalizeIdentifier("doi", paper.doi);
      const set = doiToEntities.get(key) ?? new Set<string>();
      set.add(paper.entityId);
      doiToEntities.set(key, set);
    }

    const conflicts = Array.from(doiToEntities.entries())
      .filter(([, entityIds]) => entityIds.size > 1)
      .map(([doi, entityIds]) => `${doi}: ${Array.from(entityIds).join(", ")}`);

    expect(conflicts, conflicts.join("\n")).toHaveLength(0);
  });

  it("exact arXiv duplicates collapse to one PaperEntity", async () => {
    const papers = await prisma.paper.findMany({
      where: {
        arxivId: { not: null },
        entityId: { not: null },
      },
      select: {
        arxivId: true,
        entityId: true,
      },
    });

    const arxivToEntities = new Map<string, Set<string>>();
    for (const paper of papers) {
      if (!paper.arxivId || !paper.entityId) continue;
      const key = normalizeIdentifier("arxiv", paper.arxivId);
      const set = arxivToEntities.get(key) ?? new Set<string>();
      set.add(paper.entityId);
      arxivToEntities.set(key, set);
    }

    const conflicts = Array.from(arxivToEntities.entries())
      .filter(([, entityIds]) => entityIds.size > 1)
      .map(([arxivId, entityIds]) => `${arxivId}: ${Array.from(entityIds).join(", ")}`);

    expect(conflicts, conflicts.join("\n")).toHaveLength(0);
  });

  it("Paper and DiscoveryProposal sharing an exact DOI resolve to the same PaperEntity", async () => {
    const papers = await prisma.paper.findMany({
      where: {
        doi: { not: null },
        entityId: { not: null },
      },
      select: {
        doi: true,
        entityId: true,
      },
    });

    const proposals = await prisma.discoveryProposal.findMany({
      where: {
        doi: { not: null },
        entityId: { not: null },
      },
      select: {
        doi: true,
        entityId: true,
      },
    });

    const paperEntityByDoi = new Map<string, string>();
    for (const paper of papers) {
      if (!paper.doi || !paper.entityId) continue;
      paperEntityByDoi.set(normalizeIdentifier("doi", paper.doi), paper.entityId);
    }

    const mismatches: string[] = [];
    for (const proposal of proposals) {
      if (!proposal.doi || !proposal.entityId) continue;
      const key = normalizeIdentifier("doi", proposal.doi);
      const paperEntityId = paperEntityByDoi.get(key);
      if (paperEntityId && paperEntityId !== proposal.entityId) {
        mismatches.push(`${key}: paper=${paperEntityId}, proposal=${proposal.entityId}`);
      }
    }

    expect(mismatches, mismatches.join("\n")).toHaveLength(0);
  });

  it("Paper and DiscoveryProposal sharing an exact arXiv ID resolve to the same PaperEntity", async () => {
    const papers = await prisma.paper.findMany({
      where: {
        arxivId: { not: null },
        entityId: { not: null },
      },
      select: {
        arxivId: true,
        entityId: true,
      },
    });

    const proposals = await prisma.discoveryProposal.findMany({
      where: {
        arxivId: { not: null },
        entityId: { not: null },
      },
      select: {
        arxivId: true,
        entityId: true,
      },
    });

    const paperEntityByArxiv = new Map<string, string>();
    for (const paper of papers) {
      if (!paper.arxivId || !paper.entityId) continue;
      paperEntityByArxiv.set(normalizeIdentifier("arxiv", paper.arxivId), paper.entityId);
    }

    const mismatches: string[] = [];
    for (const proposal of proposals) {
      if (!proposal.arxivId || !proposal.entityId) continue;
      const key = normalizeIdentifier("arxiv", proposal.arxivId);
      const paperEntityId = paperEntityByArxiv.get(key);
      if (paperEntityId && paperEntityId !== proposal.entityId) {
        mismatches.push(`${key}: paper=${paperEntityId}, proposal=${proposal.entityId}`);
      }
    }

    expect(mismatches, mismatches.join("\n")).toHaveLength(0);
  });
});
