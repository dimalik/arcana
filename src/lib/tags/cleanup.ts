/**
 * Tag cleanup: delete orphans, merge similar singletons, refresh scores.
 */

import { prisma } from "@/lib/prisma";
import { findMatchingTag } from "./normalize";
import { computeTagScores, type ScoredTag } from "./scoring";

export interface CleanupResult {
  orphansDeleted: string[];
  singletonsMerged: { from: string; into: string }[];
  singletonsKept: string[];
  scoresUpdated: number;
  tagsBefore: number;
  tagsAfter: number;
}

/**
 * Run full tag cleanup:
 * 1. Delete orphan tags (0 papers)
 * 2. Try to merge singletons into similar tags
 * 3. Recompute all scores and persist to DB
 */
export async function runTagCleanup(): Promise<CleanupResult> {
  const allTags = await prisma.tag.findMany({
    include: { _count: { select: { papers: true } } },
  });
  const tagsBefore = allTags.length;

  // 1. Delete orphans (0 papers)
  const orphans = allTags.filter((t) => t._count.papers === 0);
  const orphanIds = orphans.map((t) => t.id);
  if (orphanIds.length > 0) {
    await prisma.tag.deleteMany({ where: { id: { in: orphanIds } } });
  }

  // 2. Merge singletons into similar tags
  const remaining = allTags.filter((t) => !orphanIds.includes(t.id));
  const singletons = remaining.filter((t) => t._count.papers === 1);
  const nonSingletons = remaining.filter((t) => t._count.papers > 1);
  const merged: { from: string; into: string }[] = [];
  const kept: string[] = [];

  for (const s of singletons) {
    const match = findMatchingTag(
      s.name,
      nonSingletons.map((t) => ({ id: t.id, name: t.name })),
      0.7,
    );

    if (match) {
      // Merge: move paper associations from singleton to match target
      const paperTags = await prisma.paperTag.findMany({
        where: { tagId: s.id },
      });
      const existingPaperIds = new Set(
        (await prisma.paperTag.findMany({
          where: { tagId: match.id },
          select: { paperId: true },
        })).map((pt) => pt.paperId),
      );

      for (const pt of paperTags) {
        if (!existingPaperIds.has(pt.paperId)) {
          await prisma.paperTag
            .create({ data: { paperId: pt.paperId, tagId: match.id } })
            .catch(() => {}); // skip duplicate
        }
      }

      await prisma.paperTag.deleteMany({ where: { tagId: s.id } });
      await prisma.tag.delete({ where: { id: s.id } });
      merged.push({ from: s.name, into: match.name });
    } else {
      kept.push(s.name);
    }
  }

  // 3. Refresh scores
  const scoresUpdated = await refreshTagScores();

  const tagsAfter = await prisma.tag.count();

  return {
    orphansDeleted: orphans.map((t) => t.name),
    singletonsMerged: merged,
    singletonsKept: kept,
    scoresUpdated,
    tagsBefore,
    tagsAfter,
  };
}

/**
 * Recompute IDF scores for all tags and persist to DB.
 * Called after auto-tagging and after cleanup.
 */
export async function refreshTagScores(): Promise<number> {
  const tags = await prisma.tag.findMany({
    include: { _count: { select: { papers: true } } },
  });
  const totalPapers = await prisma.paper.count();

  const scored: ScoredTag[] = computeTagScores(
    tags.map((t) => ({ id: t.id, name: t.name, paperCount: t._count.papers })),
    totalPapers,
  );

  // Batch update scores
  for (const s of scored) {
    await prisma.tag.update({
      where: { id: s.id },
      data: { score: s.score },
    });
  }

  return scored.length;
}
