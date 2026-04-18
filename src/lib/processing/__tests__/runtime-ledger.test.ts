import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  prisma: {
    processingRun: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    processingStepRun: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    processingBatch: {
      findMany: vi.fn(),
    },
    paper: {
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: hoisted.prisma,
}));

import {
  createProcessingRun,
  finishProcessingRun,
  readPersistedProcessingStatus,
} from "../runtime-ledger";

describe("runtime ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.prisma.processingRun.create.mockResolvedValue({ id: "run-1" });
    hoisted.prisma.processingStepRun.create.mockResolvedValue({ id: "step-1" });
    hoisted.prisma.processingStepRun.updateMany.mockResolvedValue({ count: 1 });
    hoisted.prisma.processingRun.update.mockResolvedValue({ id: "run-1" });
    hoisted.prisma.paper.update.mockResolvedValue({ id: "paper-1" });
  });

  it("creates a processing run and projects the compatibility fields in one path", async () => {
    await createProcessingRun({
      paperId: "paper-1",
      trigger: "queue",
      processingStatus: "EXTRACTING_TEXT",
      processingStep: "extracting_text",
      metadata: { source: "queue" },
    });

    expect(hoisted.prisma.processingRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paperId: "paper-1",
        trigger: "queue",
        status: "RUNNING",
        metadata: JSON.stringify({ source: "queue" }),
      }),
    });
    expect(hoisted.prisma.processingStepRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        processingRunId: "run-1",
        paperId: "paper-1",
        step: "extracting_text",
        status: "RUNNING",
      }),
    });
    expect(hoisted.prisma.paper.update).toHaveBeenCalledWith({
      where: { id: "paper-1" },
      data: expect.objectContaining({
        processingStatus: "EXTRACTING_TEXT",
        processingStep: "extracting_text",
        processingStartedAt: expect.any(Date),
      }),
    });
  });

  it("finishes an active run and clears the compatibility step projection", async () => {
    await finishProcessingRun({
      paperId: "paper-1",
      processingRunId: "run-1",
      processingStatus: "FAILED",
      runStatus: "FAILED",
      activeStepStatus: "FAILED",
      error: "boom",
    });

    expect(hoisted.prisma.processingStepRun.updateMany).toHaveBeenCalledWith({
      where: {
        processingRunId: "run-1",
        status: "RUNNING",
      },
      data: expect.objectContaining({
        status: "FAILED",
        error: "boom",
        completedAt: expect.any(Date),
      }),
    });
    expect(hoisted.prisma.processingRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: "FAILED",
        error: "boom",
        completedAt: expect.any(Date),
      }),
    });
    expect(hoisted.prisma.paper.update).toHaveBeenCalledWith({
      where: { id: "paper-1" },
      data: {
        processingStatus: "FAILED",
        processingStep: null,
        processingStartedAt: null,
      },
    });
  });

  it("reads persisted runtime truth from the ledger and active batches", async () => {
    hoisted.prisma.processingRun.findMany.mockResolvedValue([
      {
        id: "run-1",
        paperId: "paper-1",
        trigger: "queue",
        status: "RUNNING",
        startedAt: new Date("2026-04-18T12:00:00Z"),
        paper: {
          title: "Paper One",
          processingStatus: "TEXT_EXTRACTED",
          processingStep: "summarize",
          processingStartedAt: new Date("2026-04-18T12:01:00Z"),
        },
      },
    ]);
    hoisted.prisma.processingBatch.findMany.mockResolvedValue([
      {
        id: "batch-1",
        groupId: "group-1",
        phase: 2,
        status: "PROCESSING",
        requestCount: 12,
        completedCount: 8,
        failedCount: 1,
        createdAt: new Date("2026-04-18T11:00:00Z"),
      },
    ]);

    await expect(readPersistedProcessingStatus()).resolves.toEqual({
      source: "persisted",
      processing: "paper-1",
      queue: [],
      queueLength: 0,
      activeCount: 1,
      batchPending: 1,
      activeRuns: [
        {
          runId: "run-1",
          paperId: "paper-1",
          title: "Paper One",
          trigger: "queue",
          status: "TEXT_EXTRACTED",
          step: "summarize",
          processingStartedAt: new Date("2026-04-18T12:01:00Z"),
          startedAt: new Date("2026-04-18T12:00:00Z"),
        },
      ],
      activeBatches: [
        {
          id: "batch-1",
          groupId: "group-1",
          phase: 2,
          status: "PROCESSING",
          requestCount: 12,
          completedCount: 8,
          failedCount: 1,
          createdAt: new Date("2026-04-18T11:00:00Z"),
        },
      ],
    });
  });
});
