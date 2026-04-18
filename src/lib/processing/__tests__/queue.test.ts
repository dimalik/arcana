import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paper: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
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

import { prisma } from "@/lib/prisma";
import { ProcessingQueue } from "../queue";

describe("ProcessingQueue recoverStalled", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not duplicate a paper that is already batch-pending", async () => {
    vi.mocked(prisma.paper.findMany)
      .mockResolvedValueOnce([
        { id: "paper-1", processingStatus: "TEXT_EXTRACTED", processingStep: null },
      ] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(prisma.paper.update).mockResolvedValue({} as never);

    const queue = new ProcessingQueue();
    (queue as any).batchPending = ["paper-1"];
    (queue as any).fillSlots = vi.fn();

    await queue.recoverStalled();

    expect((queue as any).queue).toEqual([]);
    expect((queue as any).batchPending).toEqual(["paper-1"]);
    expect(prisma.paper.update).toHaveBeenCalledTimes(1);
    expect((queue as any).fillSlots).toHaveBeenCalledTimes(1);
  });
});
