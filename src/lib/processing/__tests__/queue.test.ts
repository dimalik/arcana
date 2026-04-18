import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  prisma: {
    paper: {
      findUnique: vi.fn(),
    },
  },
  reconcileProcessingRuntime: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: hoisted.prisma,
}));

vi.mock("@/lib/llm/auto-process", () => ({
  runTextExtraction: vi.fn(),
  runAutoProcessPipeline: vi.fn(),
  runDeferredSteps: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/tags/maintenance", () => ({
  notifyPaperProcessed: vi.fn(),
  maybeRunTagMaintenance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/processing/batch", () => ({
  pollAllActiveBatches: vi.fn().mockResolvedValue({ completed: 0 }),
}));

vi.mock("@/lib/processing/runtime-ledger", () => ({
  createProcessingRun: vi.fn(),
  finishProcessingRun: vi.fn(),
  getLatestActiveRunForPaper: vi.fn(),
  reconcileProcessingRuntime: hoisted.reconcileProcessingRuntime,
  setProcessingProjection: vi.fn(),
}));

import { ProcessingQueue } from "../queue";

describe("ProcessingQueue recoverStalled", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not duplicate a paper that is already batch-pending", async () => {
    hoisted.reconcileProcessingRuntime.mockResolvedValue({
      recoveredPaperIds: ["paper-1"],
      abandonedPendingIds: [],
    });

    const queue = new ProcessingQueue();
    const queuePrivate = queue as unknown as {
      batchPending: string[];
      queue: string[];
      fillSlots: ReturnType<typeof vi.fn>;
    };
    queuePrivate.batchPending = ["paper-1"];
    queuePrivate.fillSlots = vi.fn();

    await queue.recoverStalled();

    expect(queuePrivate.queue).toEqual([]);
    expect(queuePrivate.batchPending).toEqual(["paper-1"]);
    expect(queuePrivate.fillSlots).toHaveBeenCalledTimes(1);
  });
});
