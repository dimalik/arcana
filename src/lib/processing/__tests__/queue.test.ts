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
    (queue as any).batchPending = ["paper-1"];
    (queue as any).fillSlots = vi.fn();

    await queue.recoverStalled();

    expect((queue as any).queue).toEqual([]);
    expect((queue as any).batchPending).toEqual(["paper-1"]);
    expect((queue as any).fillSlots).toHaveBeenCalledTimes(1);
  });
});
