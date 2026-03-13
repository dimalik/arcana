/**
 * Periodic tag maintenance: cleanup + clustering.
 *
 * Triggered automatically when:
 * - The processing queue drains (all papers done)
 * - A batch processing run completes
 *
 * Uses a volume threshold to avoid running too frequently:
 * only runs if >= THRESHOLD new papers have been processed since last run.
 */

import { prisma } from "@/lib/prisma";
import { runTagCleanup } from "./cleanup";
import { generateTagClusters } from "./clustering";

const PAPER_THRESHOLD = 10; // Run after at least N new papers processed since last maintenance
const MIN_INTERVAL_MS = 30 * 60 * 1000; // At most once per 30 minutes

// Track state in-memory (survives HMR via globalThis)
const globalForMaint = globalThis as unknown as {
  tagMaintenanceState: {
    lastRunAt: number;
    papersProcessedSinceRun: number;
    running: boolean;
  } | undefined;
};

const state = globalForMaint.tagMaintenanceState ?? {
  lastRunAt: 0,
  papersProcessedSinceRun: 0,
  running: false,
};
globalForMaint.tagMaintenanceState = state;

/**
 * Notify that a paper was processed (call after each paper completes).
 * Automatically triggers maintenance if threshold is reached.
 */
export function notifyPaperProcessed(): void {
  state.papersProcessedSinceRun++;
}

/**
 * Check if maintenance should run and run it if so.
 * Called when the processing queue drains.
 */
export async function maybeRunTagMaintenance(): Promise<boolean> {
  if (state.running) return false;

  const now = Date.now();
  const timeSinceRun = now - state.lastRunAt;

  // Skip if too recent or not enough papers
  if (timeSinceRun < MIN_INTERVAL_MS) return false;
  if (state.papersProcessedSinceRun < PAPER_THRESHOLD) return false;

  state.running = true;
  console.log(`[tag-maintenance] Starting (${state.papersProcessedSinceRun} papers since last run)`);

  try {
    // Step 1: Cleanup — delete orphans, merge singletons, refresh scores
    const cleanupResult = await runTagCleanup();
    console.log(
      `[tag-maintenance] Cleanup: ${cleanupResult.tagsBefore} → ${cleanupResult.tagsAfter} tags, ` +
      `${cleanupResult.orphansDeleted.length} orphans deleted, ${cleanupResult.singletonsMerged.length} merged`
    );

    // Step 2: Re-cluster if we have enough tags
    const tagCount = await prisma.tag.count();
    if (tagCount >= 5) {
      const clusterResult = await generateTagClusters();
      console.log(
        `[tag-maintenance] Clustering: ${clusterResult.clusters.length} clusters created, ` +
        `${clusterResult.unassigned.length} unassigned`
      );
    }

    state.lastRunAt = Date.now();
    state.papersProcessedSinceRun = 0;
    console.log("[tag-maintenance] Complete");
    return true;
  } catch (e) {
    console.error("[tag-maintenance] Failed:", e);
    return false;
  } finally {
    state.running = false;
  }
}
