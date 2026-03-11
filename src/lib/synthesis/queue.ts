import { prisma } from "@/lib/prisma";
import { runSynthesisPipeline, runPhase1, runPhase2 } from "./pipeline";

const STALL_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

class SynthesisQueue {
  private running = new Map<string, AbortController>();
  private initialized = false;

  enqueue(sessionId: string): void {
    if (!this.initialized) {
      this.initialized = true;
      this.recoverStalled().catch((e) =>
        console.error("[synthesis-queue] Stall recovery failed:", e)
      );
    }

    if (this.running.has(sessionId)) return;

    console.log(`[synthesis-queue] Enqueued session ${sessionId}`);
    this.processSession(sessionId).catch((e) =>
      console.error(`[synthesis-queue] Unhandled error in session ${sessionId}:`, e)
    );
  }

  async resume(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;

    console.log(`[synthesis-queue] Resuming session ${sessionId} (phase 2)`);
    const abortController = new AbortController();
    this.running.set(sessionId, abortController);

    try {
      await runPhase2(sessionId, abortController.signal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Synthesis failed";
      console.error(`[synthesis-queue] Session ${sessionId} phase2 failed:`, message);

      try {
        await prisma.synthesisSession.update({
          where: { id: sessionId },
          data: {
            status: abortController.signal.aborted ? "CANCELLED" : "FAILED",
            error: message,
            completedAt: new Date(),
          },
        });
      } catch {
        // Session may have been deleted
      }
    } finally {
      this.running.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<boolean> {
    const controller = this.running.get(sessionId);
    if (controller) {
      console.log(`[synthesis-queue] Cancelling session ${sessionId}`);
      controller.abort();
      return true;
    }
    return false;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  private async processSession(sessionId: string): Promise<void> {
    const abortController = new AbortController();
    this.running.set(sessionId, abortController);

    try {
      await prisma.synthesisSession.update({
        where: { id: sessionId },
        data: { status: "PLANNING", startedAt: new Date() },
      });

      const session = await prisma.synthesisSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { mode: true },
      });

      if (session.mode === "guided") {
        // Guided: only run phase 1, then pause at GUIDING
        await runPhase1(sessionId, abortController.signal);
      } else {
        // Auto: run full pipeline
        await runSynthesisPipeline(sessionId, abortController.signal);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Synthesis failed";
      console.error(`[synthesis-queue] Session ${sessionId} failed:`, message);

      try {
        await prisma.synthesisSession.update({
          where: { id: sessionId },
          data: {
            status: abortController.signal.aborted ? "CANCELLED" : "FAILED",
            error: message,
            completedAt: new Date(),
          },
        });
      } catch {
        // Session may have been deleted
      }
    } finally {
      this.running.delete(sessionId);
    }
  }

  private async recoverStalled(): Promise<void> {
    const stallCutoff = new Date(Date.now() - STALL_THRESHOLD_MS);

    // GUIDING is user-paced — exclude from stall recovery
    const stalled = await prisma.synthesisSession.findMany({
      where: {
        status: { in: ["PENDING", "PLANNING", "MAPPING", "GRAPHING", "EXPANDING", "REDUCING", "COMPOSING"] },
        OR: [
          { startedAt: { lt: stallCutoff } },
          { startedAt: null, createdAt: { lt: stallCutoff } },
        ],
      },
      select: { id: true },
    });

    if (stalled.length > 0) {
      console.log(
        `[synthesis-queue] Recovering ${stalled.length} stalled sessions`
      );
      for (const session of stalled) {
        await prisma.synthesisSession.update({
          where: { id: session.id },
          data: {
            status: "FAILED",
            error: "Session stalled and was automatically recovered",
            completedAt: new Date(),
          },
        });
      }
    }
  }
}

// Singleton — survives HMR in development via globalThis
const globalForQueue = globalThis as unknown as {
  synthesisQueue: SynthesisQueue | undefined;
};

export const synthesisQueue =
  globalForQueue.synthesisQueue ?? new SynthesisQueue();

if (process.env.NODE_ENV !== "production") {
  globalForQueue.synthesisQueue = synthesisQueue;
}
