import { prisma } from "@/lib/prisma";
import { runTextExtraction, runAutoProcessPipeline } from "@/lib/llm/auto-process";

const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export class CancelledError extends Error {
  constructor(paperId: string) {
    super(`Processing cancelled for ${paperId}`);
    this.name = "CancelledError";
  }
}

class ProcessingQueue {
  private queue: string[] = [];
  private processing: string | null = null;
  private abortController: AbortController | null = null;
  private initialized = false;

  /**
   * Add a paper to the processing queue (deduped).
   * If nothing is currently processing, starts processNext().
   */
  enqueue(paperId: string): void {
    // Recover stalled papers on first use
    if (!this.initialized) {
      this.initialized = true;
      this.recoverStalled().catch((e) =>
        console.error("[queue] Stall recovery failed:", e)
      );
    }

    // Dedupe: don't add if already queued or currently processing
    if (this.processing === paperId || this.queue.includes(paperId)) {
      return;
    }

    this.queue.push(paperId);
    console.log(`[queue] Enqueued ${paperId} (queue length: ${this.queue.length})`);

    // If nothing is running, start processing
    if (!this.processing) {
      this.processNext();
    }
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
    if (this.processing === paperId && this.abortController) {
      console.log(`[queue] Aborting active processing for ${paperId}`);
      this.abortController.abort();
      // The processNext loop will handle cleanup via the CancelledError catch
      return true;
    }

    return false;
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = null;
      this.abortController = null;
      return;
    }

    const paperId = this.queue.shift()!;
    this.processing = paperId;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    console.log(`[queue] Processing ${paperId} (${this.queue.length} remaining)`);

    try {
      // Check cancellation before starting
      if (signal.aborted) throw new CancelledError(paperId);

      // Check if paper needs text extraction
      const paper = await prisma.paper.findUnique({
        where: { id: paperId },
        select: { filePath: true, fullText: true, sourceType: true, processingStatus: true },
      });

      if (!paper) {
        console.error(`[queue] Paper not found: ${paperId}`);
        this.processing = null;
        this.abortController = null;
        this.processNext();
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
          this.processing = null;
          this.abortController = null;
          this.processNext();
          return;
        }
      }

      if (signal.aborted) throw new CancelledError(paperId);

      // Re-fetch to check for text availability and determine skipExtract
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
        this.processing = null;
        this.abortController = null;
        this.processNext();
        return;
      }

      // Step 2: Run LLM pipeline
      // Skip metadata extraction for ArXiv/OpenReview papers (already have metadata)
      const skipExtract = updated.sourceType === "ARXIV" || updated.sourceType === "OPENREVIEW";
      await runAutoProcessPipeline({ paperId, skipExtract, signal });

    } catch (e) {
      const cancelled = signal.aborted || e instanceof CancelledError;
      if (cancelled) {
        console.log(`[queue] Processing cancelled for ${paperId}`);
      } else {
        console.error(`[queue] Pipeline failed for ${paperId}:`, e);
      }
      // Mark paper as failed
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

    // Always process the next item
    this.processing = null;
    this.abortController = null;
    this.processNext();
  }

  /**
   * Find papers stuck in a non-terminal status with stale processingStartedAt
   * and re-enqueue them. Called automatically on first enqueue().
   */
  async recoverStalled(): Promise<void> {
    const stallCutoff = new Date(Date.now() - STALL_THRESHOLD_MS);

    // Find papers that are stuck: non-terminal status with an old processingStartedAt
    const stalledPapers = await prisma.paper.findMany({
      where: {
        processingStatus: {
          notIn: ["COMPLETED", "FAILED", "PENDING"],
        },
        processingStartedAt: {
          lt: stallCutoff,
        },
      },
      select: { id: true, processingStatus: true, processingStep: true },
    });

    // Also find papers with non-terminal status but NO processingStartedAt
    // (legacy papers from before this feature, or papers where the server crashed before setting it)
    const legacyStuck = await prisma.paper.findMany({
      where: {
        processingStatus: {
          notIn: ["COMPLETED", "FAILED", "PENDING"],
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
        // Reset step tracking so the queue starts fresh
        await prisma.paper.update({
          where: { id: paper.id },
          data: {
            processingStep: null,
            processingStartedAt: null,
          },
        });

        // Enqueue for reprocessing (dedupe handled by enqueue)
        if (!this.queue.includes(paper.id) && this.processing !== paper.id) {
          this.queue.push(paper.id);
        }
      }
    }
  }

  /**
   * Get current queue status for the API.
   */
  getStatus(): { processing: string | null; queue: string[]; queueLength: number } {
    return {
      processing: this.processing,
      queue: [...this.queue],
      queueLength: this.queue.length,
    };
  }
}

// Singleton — survives HMR in development via globalThis
const globalForQueue = globalThis as unknown as {
  processingQueue: ProcessingQueue | undefined;
};

export const processingQueue =
  globalForQueue.processingQueue ?? new ProcessingQueue();

if (process.env.NODE_ENV !== "production") {
  globalForQueue.processingQueue = processingQueue;
}
