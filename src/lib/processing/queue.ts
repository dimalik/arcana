import { prisma } from "@/lib/prisma";
import { runTextExtraction, runAutoProcessPipeline, runDeferredSteps } from "@/lib/llm/auto-process";
import { notifyPaperProcessed, maybeRunTagMaintenance } from "@/lib/tags/maintenance";

const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT = 3; // Process up to N papers simultaneously

export class CancelledError extends Error {
  constructor(paperId: string) {
    super(`Processing cancelled for ${paperId}`);
    this.name = "CancelledError";
  }
}

class ProcessingQueue {
  private queue: string[] = [];
  private processing = new Map<string, AbortController>();
  private initialized = false;
  private runningDeferred = false;

  /**
   * Add a paper to the processing queue (deduped).
   * Starts processing if slots are available.
   */
  enqueue(paperId: string): void {
    if (!this.initialized) {
      this.initialized = true;
      this.recoverStalled().catch((e) =>
        console.error("[queue] Stall recovery failed:", e)
      );
    }

    // Dedupe: don't add if already queued or currently processing
    if (this.processing.has(paperId) || this.queue.includes(paperId)) {
      return;
    }

    this.queue.push(paperId);
    console.log(`[queue] Enqueued ${paperId} (queue: ${this.queue.length}, active: ${this.processing.size})`);

    // Fill available slots
    this.fillSlots();
  }

  /**
   * Cancel a paper's processing. If it's currently running, aborts it.
   * If it's queued, removes it. Sets status to FAILED.
   */
  async cancel(paperId: string): Promise<boolean> {
    // Remove from queue if waiting
    const idx = this.queue.indexOf(paperId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      console.log(`[queue] Removed ${paperId} from queue`);
      await prisma.paper.update({
        where: { id: paperId },
        data: {
          processingStatus: "FAILED",
          processingStep: null,
          processingStartedAt: null,
        },
      });
      return true;
    }

    // Abort if currently processing
    const controller = this.processing.get(paperId);
    if (controller) {
      console.log(`[queue] Aborting active processing for ${paperId}`);
      controller.abort();
      return true;
    }

    return false;
  }

  /**
   * Start processing papers up to MAX_CONCURRENT slots.
   * When the queue drains, pick up NEEDS_DEFERRED papers automatically.
   */
  private fillSlots(): void {
    while (this.queue.length > 0 && this.processing.size < MAX_CONCURRENT) {
      const paperId = this.queue.shift()!;
      this.startProcessing(paperId);
    }

    // When queue is empty and no active processing, run deferred steps then tag maintenance
    if (this.queue.length === 0 && this.processing.size === 0 && !this.runningDeferred) {
      this.runningDeferred = true;
      runDeferredSteps()
        .then(async (count) => {
          if (count > 0) {
            console.log(`[queue] Completed deferred processing for ${count} papers`);
          }
          // After all processing completes, run tag maintenance if threshold reached
          await maybeRunTagMaintenance();
        })
        .catch((e) => console.error("[queue] Deferred processing failed:", e))
        .finally(() => { this.runningDeferred = false; });
    }
  }

  private startProcessing(paperId: string): void {
    const controller = new AbortController();
    this.processing.set(paperId, controller);
    console.log(`[queue] Processing ${paperId} (active: ${this.processing.size}, queued: ${this.queue.length})`);

    this.processPaper(paperId, controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted) {
          console.error(`[queue] Pipeline failed for ${paperId}:`, e);
        }
      })
      .finally(() => {
        this.processing.delete(paperId);
        // Fill the freed slot
        this.fillSlots();
      });
  }

  private async processPaper(paperId: string, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) throw new CancelledError(paperId);

      const paper = await prisma.paper.findUnique({
        where: { id: paperId },
        select: { filePath: true, fullText: true, sourceType: true, processingStatus: true },
      });

      if (!paper) {
        console.error(`[queue] Paper not found: ${paperId}`);
        return;
      }

      // Step 1: Extract text if needed (has file but no fullText)
      if (paper.filePath && !paper.fullText) {
        if (signal.aborted) throw new CancelledError(paperId);
        try {
          await runTextExtraction(paperId);
        } catch (e) {
          if (signal.aborted) throw new CancelledError(paperId);
          console.error(`[queue] Text extraction failed for ${paperId}:`, e);
          await prisma.paper.update({
            where: { id: paperId },
            data: {
              processingStatus: "FAILED",
              processingStep: null,
              processingStartedAt: null,
            },
          });
          return;
        }
      }

      if (signal.aborted) throw new CancelledError(paperId);

      // Re-fetch to check text availability
      const updated = await prisma.paper.findUnique({
        where: { id: paperId },
        select: { fullText: true, abstract: true, sourceType: true },
      });

      if (!updated?.fullText && !updated?.abstract) {
        console.error(`[queue] No text available for ${paperId}, skipping LLM pipeline`);
        await prisma.paper.update({
          where: { id: paperId },
          data: {
            processingStatus: "FAILED",
            processingStep: null,
            processingStartedAt: null,
          },
        });
        return;
      }

      // Step 2: Run LLM pipeline
      // When backlog is large (>5 papers), run essential-only mode to get summaries fast.
      // Deferred steps (linking, refs, distill) run later when queue drains.
      const skipExtract = updated.sourceType === "ARXIV" || updated.sourceType === "OPENREVIEW";
      const backlogSize = this.queue.length + this.processing.size;
      const essentialOnly = backlogSize > 5;
      if (essentialOnly) {
        console.log(`[queue] Large backlog (${backlogSize}), running essential-only for ${paperId}`);
      }
      await runAutoProcessPipeline({ paperId, skipExtract, signal, essentialOnly });
      notifyPaperProcessed();

    } catch (e) {
      const cancelled = signal.aborted || e instanceof CancelledError;
      if (cancelled) {
        console.log(`[queue] Processing cancelled for ${paperId}`);
      } else {
        console.error(`[queue] Pipeline failed for ${paperId}:`, e);
      }
      try {
        await prisma.paper.update({
          where: { id: paperId },
          data: {
            processingStatus: "FAILED",
            processingStep: null,
            processingStartedAt: null,
          },
        });
      } catch {
        // Paper may have been deleted
      }
    }
  }

  /**
   * Find papers stuck in a non-terminal status with stale processingStartedAt
   * and re-enqueue them. Called automatically on first enqueue().
   */
  async recoverStalled(): Promise<void> {
    const stallCutoff = new Date(Date.now() - STALL_THRESHOLD_MS);

    const stalledPapers = await prisma.paper.findMany({
      where: {
        processingStatus: {
          notIn: ["COMPLETED", "FAILED", "PENDING", "NEEDS_DEFERRED", "NO_PDF", "BATCH_PROCESSING"],
        },
        processingStartedAt: {
          lt: stallCutoff,
        },
      },
      select: { id: true, processingStatus: true, processingStep: true },
    });

    const legacyStuck = await prisma.paper.findMany({
      where: {
        processingStatus: {
          notIn: ["COMPLETED", "FAILED", "PENDING", "NEEDS_DEFERRED", "NO_PDF", "BATCH_PROCESSING"],
        },
        processingStartedAt: null,
      },
      select: { id: true, processingStatus: true, processingStep: true },
    });

    const allStalled = [...stalledPapers, ...legacyStuck];

    if (allStalled.length > 0) {
      console.log(
        `[queue] Recovering ${allStalled.length} stalled papers:`,
        allStalled.map((p) => `${p.id} (${p.processingStatus}/${p.processingStep})`),
      );

      for (const paper of allStalled) {
        await prisma.paper.update({
          where: { id: paper.id },
          data: {
            processingStep: null,
            processingStartedAt: null,
          },
        });

        if (!this.queue.includes(paper.id) && !this.processing.has(paper.id)) {
          this.queue.push(paper.id);
        }
      }

      // Kick off processing for recovered papers
      this.fillSlots();
    }
  }

  /**
   * Get current queue status for the API.
   */
  getStatus(): { processing: string | null; queue: string[]; queueLength: number; activeCount: number } {
    return {
      processing: this.processing.size > 0 ? Array.from(this.processing.keys())[0] : null,
      queue: [...this.queue],
      queueLength: this.queue.length,
      activeCount: this.processing.size,
    };
  }
}

// Singleton — survives HMR in development via globalThis
const globalForQueue = globalThis as unknown as {
  processingQueue: ProcessingQueue | undefined;
  batchPollInterval: ReturnType<typeof setInterval> | undefined;
};

export const processingQueue =
  globalForQueue.processingQueue ?? new ProcessingQueue();

if (process.env.NODE_ENV !== "production") {
  globalForQueue.processingQueue = processingQueue;
}

// Auto-poll active batches every 5 minutes
if (!globalForQueue.batchPollInterval) {
  globalForQueue.batchPollInterval = setInterval(async () => {
    try {
      const { pollAllActiveBatches } = await import("./batch");
      const result = await pollAllActiveBatches();
      if (result.completed > 0) {
        console.log(`[batch-poll] Auto-polled: ${result.completed} batches completed`);
      }
    } catch {
      // Batch module may not be initialized yet
    }
  }, 5 * 60 * 1000);
}
