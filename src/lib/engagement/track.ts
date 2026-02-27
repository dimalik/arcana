import { prisma } from "@/lib/prisma";

export type EngagementEvent =
  | "view"
  | "pdf_open"
  | "annotate"
  | "chat"
  | "concept_explore"
  | "discovery_seed"
  | "import";

// Weights for computing engagement score (time-decayed)
const EVENT_WEIGHTS: Record<EngagementEvent, number> = {
  view: 1,
  pdf_open: 2,
  annotate: 4,
  chat: 3,
  concept_explore: 3,
  discovery_seed: 5,
  import: 2,
};

// Half-life in days: engagement decays by half every N days
const HALF_LIFE_DAYS = 14;

/**
 * Record an engagement event and update the paper's score.
 */
export async function trackEngagement(
  paperId: string,
  event: EngagementEvent
): Promise<void> {
  await prisma.paperEngagement.create({
    data: { paperId, event },
  });

  // Recompute score from all events
  const score = await computeEngagementScore(paperId);
  await prisma.paper.update({
    where: { id: paperId },
    data: { engagementScore: score },
  });
}

/**
 * Compute engagement score with exponential time decay.
 */
export async function computeEngagementScore(
  paperId: string
): Promise<number> {
  const events = await prisma.paperEngagement.findMany({
    where: { paperId },
    select: { event: true, createdAt: true },
  });

  const now = Date.now();
  const halfLifeMs = HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

  let score = 0;
  for (const e of events) {
    const age = now - new Date(e.createdAt).getTime();
    const decay = Math.pow(0.5, age / halfLifeMs);
    const weight = EVENT_WEIGHTS[e.event as EngagementEvent] ?? 1;
    score += weight * decay;
  }

  return Math.round(score * 100) / 100;
}

/**
 * Get a heat level (0-4) from engagement score for UI display.
 * 0 = cold (no engagement), 4 = hot (high engagement)
 */
export function getHeatLevel(score: number): number {
  if (score <= 0) return 0;
  if (score < 2) return 1;
  if (score < 5) return 2;
  if (score < 12) return 3;
  return 4;
}

/**
 * Batch recompute engagement scores for all papers.
 * Useful for periodic recalculation as time decays scores.
 */
export async function recomputeAllScores(): Promise<number> {
  const paperIds = await prisma.paper.findMany({
    select: { id: true },
  });

  let updated = 0;
  for (const { id } of paperIds) {
    const score = await computeEngagementScore(id);
    await prisma.paper.update({
      where: { id },
      data: { engagementScore: score },
    });
    updated++;
  }

  return updated;
}
