import { prisma } from "@/lib/prisma";
import { runTextExtraction, runAutoProcessPipeline, runDeferredSteps } from "@/lib/llm/auto-process";
import { notifyPaperProcessed, maybeRunTagMaintenance } from "@/lib/tags/maintenance";

const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT = 3; // Process up to N papers simultaneously
const BATCH_AUTO_THRESHOLD = 6; // Auto-route to Batch API when this many papers queue up
const BATCH_FLUSH_DELAY_MS = 5_000; // Wait 5s for more papers before flushing to batch

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
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private batchPending: string[] = []; // Papers waiting to be flushed to batch API

  /**
   * Add a paper to the processing queue (deduped).
   * When many papers arrive in a burst, auto-routes to the Batch API (50% cheaper).
   */
  enqueue(paperId: string): void {
    if (!this.initialized) {
      this.initialized = true;
      this.recoverStalled().catch((e) =>
        console.error("[queue] Stall recovery failed:", e)
      );
    }

    // Dedupe: don't add if already queued or currently processing
    if (this.processing.has(paperId) || this.queue.includes(paperId) || this.batchPending.includes(paperId)) {
      return;
    }

    this.batchPending.push(paperId);
    console.log(`[queue] Enqueued ${paperId} (pending: ${this.batchPending.length}, queue: ${this.queue.length}, active: ${this.processing.size})`);

    // If we already hit the batch threshold, flush immediately
    if (this.batchPending.length >= BATCH_AUTO_THRESHOLD) {
      this.flushPending();
    } else {
      // Wait briefly for more papers to arrive (search_papers imports ~8 at once)
      if (this.batchFlushTimer) clearTimeout(this.batchFlushTimer);
      this.batchFlushTimer = setTimeout(() => this.flushPending(), BATCH_FLUSH_DELAY_MS);
    }
  }

  /**
   * Flush pending papers — route to batch API if enough, otherwise sequential queue.
   */
  private flushPending(): void {
    if (this.batchFlushTimer) {
      clearTimeout(this.batchFlushTimer);
      this.batchFlushTimer = null;
    }

    const pending = this.batchPending.splice(0);
    if (pending.length === 0) return;

    if (pending.length >= BATCH_AUTO_THRESHOLD) {
      // Route to Batch API
      this.submitToBatchApi(pending);
    } else {
      // Too few for batch — process sequentially
      for (const paperId of pending) {
        this.queue.push(paperId);
      }
      this.fillSlots();
    }
  }

  /**
   * Submit papers to the Anthropic Batch API for cheaper parallel processing.
   */
  private async submitToBatchApi(paperIds: string[]): Promise<void> {
    try {
      const { createBatchJob } = await import("./batch");
      console.log(`[queue] Auto-routing ${paperIds.length} papers to Batch API (50% cheaper)`);
      const result = await createBatchJob(paperIds);
      console.log(`[queue] Batch submitted: ${result.requestCount} requests, group=${result.groupId}`);
      if (result.skippedForChunking.length > 0) {
        // Papers too long for batch — fall back to sequential for those
        console.log(`[queue] ${result.skippedForChunking.length} papers too long for batch, processing sequentially`);
        for (const paperId of result.skippedForChunking) {
          this.queue.push(paperId);
        }
        this.fillSlots();
      }
    } catch (err) {
      // Batch API not available (no proxy config, API error, etc.) — fall back to sequential
      console.warn(`[queue] Batch API unavailable, falling back to sequential:`, err instanceof Error ? err.message : err);
      for (const paperId of paperIds) {
        this.queue.push(paperId);
      }
      this.fillSlots();
    }
  }

  /**
   * Cancel a paper's processing. If it's currently running, aborts it.
   * If it's queued, removes it. Sets status to FAILED.
   */
  async cancel(paperId: string): Promise<boolean> {
    // Remove from batch pending if waiting
    const batchIdx = this.batchPending.indexOf(paperId);
    if (batchIdx !== -1) {
      this.batchPending.splice(batchIdx, 1);
      console.log(`[queue] Removed ${paperId} from batch pending`);
      return true;
    }

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

      // Non-blocking: download figures from arXiv HTML / publisher pages
      const figPaper = await prisma.paper.findUnique({
        where: { id: paperId },
        select: { arxivId: true, doi: true },
      });
      if (figPaper && (figPaper.arxivId || figPaper.doi)) {
        import("@/lib/import/figure-downloader")
          .then(({ downloadFiguresFromHtml }) =>
            downloadFiguresFromHtml(paperId, { arxivId: figPaper.arxivId, doi: figPaper.doi })
          )
          .catch((err) => console.warn(`[queue] Figure download failed for ${paperId}:`, (err as Error).message));
      }

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

    // Also recover PENDING papers that have an abstract but were never enqueued
    // (e.g., PDF download failed silently before the enqueue-on-abstract fix)
    const abandonedPending = await prisma.paper.findMany({
      where: {
        processingStatus: "PENDING",
        abstract: { not: null },
      },
      select: { id: true },
      take: 200, // Process in chunks to avoid overwhelming the queue
    });

    const allStalled = [...stalledPapers, ...legacyStuck];

    if (allStalled.length > 0) {
      console.log(
        `[queue] Recovering ${allStalled.length} stalled papers`,
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

    // Recover abandoned PENDING papers (have abstract, never enqueued)
    if (abandonedPending.length > 0) {
      console.log(`[queue] Found ${abandonedPending.length} abandoned PENDING papers with abstracts, routing to batch`);
      const ids = abandonedPending.map(p => p.id);
      // Chunk into batches of 100 papers to avoid memory/API limits
      const CHUNK_SIZE = 100;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        this.submitToBatchApi(chunk);
      }
    }
  }

  /**
   * Get current queue status for the API.
   */
  getStatus(): { processing: string | null; queue: string[]; queueLength: number; activeCount: number; batchPending: number } {
    return {
      processing: this.processing.size > 0 ? Array.from(this.processing.keys())[0] : null,
      queue: [...this.queue],
      queueLength: this.queue.length,
      activeCount: this.processing.size,
      batchPending: this.batchPending.length,
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
